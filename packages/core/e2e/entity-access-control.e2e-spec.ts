import { Permission } from '@vendure/common/lib/generated-types';
import { SUPER_ADMIN_USER_IDENTIFIER } from '@vendure/common/lib/shared-constants';
import {
    DefaultEntityAccessControlStrategy,
    ID,
    Injector,
    mergeConfig,
    Product,
    RequestContext,
    TransactionalConnection,
    VendureEntity,
} from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { LessThanOrEqual, SelectQueryBuilder } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';

import { EntityAccessControlTestPlugin } from './fixtures/test-plugins/entity-access-control-test-plugin';
import {
    CreateAdministratorMutation,
    CreateAdministratorMutationVariables,
    CreateRoleMutation,
    CreateRoleMutationVariables,
    GetProductListQuery,
    GetProductListQueryVariables,
    GetProductSimpleQuery,
    GetProductSimpleQueryVariables,
} from './graphql/generated-e2e-admin-types';
import {
    CREATE_ADMINISTRATOR,
    CREATE_ROLE,
    GET_PRODUCT_LIST,
    GET_PRODUCT_SIMPLE,
} from './graphql/shared-definitions';

const RAW_REPOSITORY_PRODUCT_IDS = gql`
    query RawRepositoryProductIds {
        rawRepositoryProductIds
    }
`;

const RAW_REPOSITORY_PRODUCT = gql`
    query RawRepositoryProduct($id: ID!) {
        rawRepositoryProduct(id: $id)
    }
`;

const RAW_REPOSITORY_PRODUCT_FIND_AND_COUNT = gql`
    query RawRepositoryProductFindAndCount {
        rawRepositoryProductFindAndCount
    }
`;

const RAW_REPOSITORY_PRODUCT_COUNT = gql`
    query RawRepositoryProductCount {
        rawRepositoryProductCount
    }
`;

/**
 * Test strategy demonstrating the full pattern:
 *
 * - Extends `DefaultEntityAccessControlStrategy` to preserve standard permission logic.
 * - Overrides `evaluateAccess()` to pre-load allowed product IDs after calling super.
 * - Implements `applyAccessControl()` for row-level filtering.
 *
 * Uses a WeakMap<RequestContext, ID[]> so that per-request data is automatically
 * garbage-collected when the request ends.
 */
class TestEntityAccessControlStrategy extends DefaultEntityAccessControlStrategy {
    /**
     * WeakMap keyed on RequestContext — entries are automatically garbage
     * collected when the request ends and the ctx reference is released.
     */
    private allowedProductIds = new WeakMap<RequestContext, ID[]>();
    private connection: TransactionalConnection;
    evaluateAccessCallCount = 0;

    init(injector: Injector) {
        this.connection = injector.get(TransactionalConnection);
    }

    /**
     * Gate-level + pre-loading phase: runs once per request in the AuthGuard.
     *
     * 1. Delegates to super for standard Vendure permission evaluation.
     * 2. If allowed, performs an async DB lookup to determine which products
     *    this user may access and stashes the result in the WeakMap.
     *
     * IMPORTANT: Uses `rawConnection.getRepository()` (NOT the ctx-aware
     * `getRepository(ctx, ...)`) to avoid triggering the access-control
     * Proxy and causing infinite recursion.
     */
    async evaluateAccess(ctx: RequestContext, permissions: Permission[]): Promise<boolean> {
        this.evaluateAccessCallCount++;

        // Delegate to DefaultEntityAccessControlStrategy for standard permission checks
        const allowed = await super.evaluateAccess(ctx, permissions);
        if (!allowed) {
            return false;
        }

        // SuperAdmin bypasses row-level access control — no cache entry means "no restrictions"
        const user = ctx.session?.user;
        if (!user || user.identifier === SUPER_ADMIN_USER_IDENTIFIER) {
            return true;
        }

        // Only pre-load once per request (WeakMap deduplication)
        if (this.allowedProductIds.has(ctx)) {
            return true;
        }

        // Simulate an async lookup: query the DB for allowed product IDs.
        // In a real implementation this might look up seller assignments,
        // role-based category access, or call an external permissions API.
        const products = await this.connection.rawConnection.getRepository(Product).find({
            where: { id: LessThanOrEqual(5) },
            select: ['id'],
        });
        this.allowedProductIds.set(
            ctx,
            products.map(p => p.id),
        );

        return true;
    }

    /**
     * Row-level phase: runs for every query. Reads the cached allowed IDs from
     * the WeakMap and applies the filter. If there's no cache entry (i.e.
     * SuperAdmin), this is a no-op.
     */
    applyAccessControl<T extends VendureEntity>(
        qb: SelectQueryBuilder<T>,
        entityType: new (...args: any[]) => T,
        ctx: RequestContext,
    ): void {
        if (entityType !== Product) {
            return;
        }

        const allowedIds = this.allowedProductIds.get(ctx);
        if (!allowedIds) {
            // No cache entry = no restrictions (SuperAdmin, or no evaluate phase)
            return;
        }

        qb.andWhere(`${qb.alias}.id IN (:...acl_allowed_ids)`, { acl_allowed_ids: allowedIds });
    }
}

describe('EntityAccessControlStrategy', () => {
    const testStrategy = new TestEntityAccessControlStrategy();
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            authOptions: {
                entityAccessControlStrategy: testStrategy,
            },
            plugins: [EntityAccessControlTestPlugin],
        }),
    );

    let allProductIds: string[] = [];

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();

        // Get all products as superadmin to know the full set
        const { products } = await adminClient.query<GetProductListQuery, GetProductListQueryVariables>(
            GET_PRODUCT_LIST,
            { options: { take: 100 } },
        );
        allProductIds = products.items.map(p => p.id);
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    describe('SuperAdmin (unrestricted)', () => {
        it('sees all products via list query', async () => {
            await adminClient.asSuperAdmin();
            const { products } = await adminClient.query<GetProductListQuery, GetProductListQueryVariables>(
                GET_PRODUCT_LIST,
                { options: { take: 100 } },
            );

            // SuperAdmin should see all 20 products
            expect(products.totalItems).toBe(20);
        });

        it('can access any product by ID, including those with id > 5', async () => {
            await adminClient.asSuperAdmin();
            // T_10 has id > 5 — restricted admin can't see it, but superadmin can
            const { product } = await adminClient.query<
                GetProductSimpleQuery,
                GetProductSimpleQueryVariables
            >(GET_PRODUCT_SIMPLE, { id: 'T_10' });
            expect(product).not.toBeNull();
            expect(product?.id).toBe('T_10');
        });

        it('sees all products via raw repository find (getRepository Proxy path)', async () => {
            await adminClient.asSuperAdmin();
            const { rawRepositoryProductIds } = await adminClient.query(RAW_REPOSITORY_PRODUCT_IDS);
            expect(rawRepositoryProductIds.length).toBe(20);
        });
    });

    describe('Restricted admin', () => {
        beforeAll(async () => {
            await adminClient.asSuperAdmin();

            // Create a role with read permissions for catalog
            const { createRole } = await adminClient.query<CreateRoleMutation, CreateRoleMutationVariables>(
                CREATE_ROLE,
                {
                    input: {
                        channelIds: ['T_1'],
                        code: 'restricted-role',
                        description: 'A restricted role for testing entity access control',
                        permissions: [Permission.ReadCatalog, Permission.ReadProduct],
                    },
                },
            );

            // Create a restricted admin
            await adminClient.query<CreateAdministratorMutation, CreateAdministratorMutationVariables>(
                CREATE_ADMINISTRATOR,
                {
                    input: {
                        firstName: 'Restricted',
                        lastName: 'Admin',
                        emailAddress: 'restricted@admin.com',
                        password: 'restricted',
                        roleIds: [createRole.id],
                    },
                },
            );

            // Log in as the restricted admin
            await adminClient.asUserWithCredentials('restricted@admin.com', 'restricted');
        });

        it('sees filtered products via list query (ListQueryBuilder path)', async () => {
            const { products } = await adminClient.query<GetProductListQuery, GetProductListQueryVariables>(
                GET_PRODUCT_LIST,
                { options: { take: 100 } },
            );

            // Should only see products with id <= 5
            expect(products.totalItems).toBe(5);
            const ids = products.items.map(p => p.id);
            expect(ids).toEqual(['T_1', 'T_2', 'T_3', 'T_4', 'T_5']);
        });

        it('cannot access a product outside the filter by ID (findOneInChannel path)', async () => {
            // T_10 has id > 5 so should be filtered out
            const { product } = await adminClient.query<
                GetProductSimpleQuery,
                GetProductSimpleQueryVariables
            >(GET_PRODUCT_SIMPLE, { id: 'T_10' });

            expect(product).toBeNull();
        });

        it('can access a product inside the filter by ID (findOneInChannel path)', async () => {
            // T_1 has id <= 5 so should be visible
            const { product } = await adminClient.query<
                GetProductSimpleQuery,
                GetProductSimpleQueryVariables
            >(GET_PRODUCT_SIMPLE, { id: 'T_1' });

            expect(product).not.toBeNull();
            expect(product?.slug).toBe('laptop');
        });

        it('list query totalItems reflects the filtered count', async () => {
            const { products } = await adminClient.query<GetProductListQuery, GetProductListQueryVariables>(
                GET_PRODUCT_LIST,
                {},
            );

            // totalItems should reflect only the filtered products
            expect(products.totalItems).toBe(5);
        });

        it('sees filtered products via raw repository find (getRepository Proxy path)', async () => {
            const { rawRepositoryProductIds } = await adminClient.query(RAW_REPOSITORY_PRODUCT_IDS);

            // Should only see products with id <= 5 via the Proxy-intercepted repo.find()
            expect(rawRepositoryProductIds.length).toBe(5);
            expect(rawRepositoryProductIds).toEqual(['1', '2', '3', '4', '5']);
        });

        it('cannot access a product outside the filter via raw repository findOne (getRepository Proxy path)', async () => {
            const { rawRepositoryProduct } = await adminClient.query(RAW_REPOSITORY_PRODUCT, { id: 'T_10' });

            // T_10 has id > 5 — the Proxy-intercepted repo.findOne() should return null
            expect(rawRepositoryProduct).toBeNull();
        });

        it('can access a product inside the filter via raw repository findOne (getRepository Proxy path)', async () => {
            const { rawRepositoryProduct } = await adminClient.query(RAW_REPOSITORY_PRODUCT, { id: 'T_1' });

            // T_1 has id <= 5 — visible through the Proxy
            expect(rawRepositoryProduct).not.toBeNull();
            expect(rawRepositoryProduct.id).toBe('T_1');
        });

        it('sees filtered count via raw repository findAndCount (getRepository Proxy path)', async () => {
            const { rawRepositoryProductFindAndCount } = await adminClient.query(
                RAW_REPOSITORY_PRODUCT_FIND_AND_COUNT,
            );
            expect(rawRepositoryProductFindAndCount).toBe(5);
        });

        it('sees filtered count via raw repository count (getRepository Proxy path)', async () => {
            const { rawRepositoryProductCount } = await adminClient.query(RAW_REPOSITORY_PRODUCT_COUNT);
            expect(rawRepositoryProductCount).toBe(5);
        });
    });

    describe('evaluateAccess denial', () => {
        it('returns ForbiddenError when user lacks required permissions', async () => {
            await adminClient.asSuperAdmin();

            // Create a role with NO catalog permissions
            const { createRole } = await adminClient.query<CreateRoleMutation, CreateRoleMutationVariables>(
                CREATE_ROLE,
                {
                    input: {
                        channelIds: ['T_1'],
                        code: 'no-catalog-role',
                        description: 'A role with no catalog permissions',
                        permissions: [],
                    },
                },
            );

            // Create an admin with that role
            await adminClient.query<CreateAdministratorMutation, CreateAdministratorMutationVariables>(
                CREATE_ADMINISTRATOR,
                {
                    input: {
                        firstName: 'NoCatalog',
                        lastName: 'Admin',
                        emailAddress: 'nocatalog@admin.com',
                        password: 'nocatalog',
                        roleIds: [createRole.id],
                    },
                },
            );

            // Log in as the no-catalog admin
            await adminClient.asUserWithCredentials('nocatalog@admin.com', 'nocatalog');

            // This should fail with FORBIDDEN because evaluateAccess returns false
            // (the admin has no ReadCatalog/ReadProduct permission)
            try {
                await adminClient.query<GetProductListQuery, GetProductListQueryVariables>(GET_PRODUCT_LIST, {
                    options: { take: 10 },
                });
                expect.unreachable('Should have thrown');
            } catch (e: any) {
                expect(e.response.errors[0].extensions.code).toBe('FORBIDDEN');
            }
        });
    });

    describe('evaluateAccess behavior', () => {
        it('evaluateAccess is called once per request (AuthGuard hook)', async () => {
            const countBefore = testStrategy.evaluateAccessCallCount;
            await adminClient.asSuperAdmin();

            // Each GraphQL query triggers the AuthGuard, which calls evaluateAccess
            await adminClient.query<GetProductListQuery, GetProductListQueryVariables>(GET_PRODUCT_LIST, {
                options: { take: 5 },
            });
            const countAfterFirst = testStrategy.evaluateAccessCallCount;
            expect(countAfterFirst).toBeGreaterThan(countBefore);

            // A second request should increment the counter again
            await adminClient.query<GetProductListQuery, GetProductListQueryVariables>(GET_PRODUCT_LIST, {
                options: { take: 5 },
            });
            const countAfterSecond = testStrategy.evaluateAccessCallCount;
            expect(countAfterSecond).toBeGreaterThan(countAfterFirst);
        });

        it('each request gets its own isolated cache entry (WeakMap isolation)', async () => {
            // Login as restricted admin
            await adminClient.asUserWithCredentials('restricted@admin.com', 'restricted');

            // Two consecutive requests should both be filtered correctly,
            // proving that each request gets its own WeakMap entry
            const { products: result1 } = await adminClient.query<
                GetProductListQuery,
                GetProductListQueryVariables
            >(GET_PRODUCT_LIST, { options: { take: 100 } });
            expect(result1.totalItems).toBe(5);

            const { products: result2 } = await adminClient.query<
                GetProductListQuery,
                GetProductListQueryVariables
            >(GET_PRODUCT_LIST, { options: { take: 100 } });
            expect(result2.totalItems).toBe(5);
        });
    });
});
