import { SUPER_ADMIN_USER_IDENTIFIER } from '@vendure/common/lib/shared-constants';
import {
    EntityAccessControlStrategy,
    mergeConfig,
    Product,
    RequestContext,
    VendureEntity,
} from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { SelectQueryBuilder } from 'typeorm';
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
    Permission,
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

/**
 * Test strategy that restricts non-superadmin users to only see
 * products with id <= 5. SuperAdmin users are not restricted.
 *
 * We use `id` because it's a real column on the product table
 * (unlike `name`/`slug` which are on the translations table).
 */
class TestEntityAccessControlStrategy implements EntityAccessControlStrategy {
    applyAccessControl<T extends VendureEntity>(
        qb: SelectQueryBuilder<T>,
        entityType: new (...args: any[]) => T,
        ctx: RequestContext,
    ): void {
        if (entityType !== Product) {
            return;
        }
        // SuperAdmin bypasses access control
        if (ctx.activeUserId == null) {
            return;
        }
        const user = ctx.session?.user;
        if (user?.identifier === SUPER_ADMIN_USER_IDENTIFIER) {
            return;
        }

        // Restricted admin can only see products with id <= 5
        qb.andWhere(`${qb.alias}.id <= :acl_max_id`, { acl_max_id: 5 });
    }
}

describe('EntityAccessControlStrategy', () => {
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            authOptions: {
                entityAccessControlStrategy: new TestEntityAccessControlStrategy(),
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
    });
});
