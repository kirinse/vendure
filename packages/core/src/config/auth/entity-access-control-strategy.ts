import { Permission } from '@vendure/common/lib/generated-types';
import { SelectQueryBuilder } from 'typeorm';

import { RequestContext } from '../../api/common/request-context';
import { InjectableStrategy } from '../../common/types/injectable-strategy';
import { VendureEntity } from '../../entity/base/base.entity';

/**
 * @description
 * An EntityAccessControlStrategy provides two layers of access control:
 *
 * 1. **Gate-level** (`evaluateAccess`): Determines whether a request should be
 *    allowed at all, replacing the default Vendure permission evaluation logic.
 *    This runs once per request in the AuthGuard.
 *
 * 2. **Row-level** (`applyAccessControl`): Filters which entities a user can see
 *    by modifying query builders. This runs for every entity query.
 *
 * The default implementation ({@link DefaultEntityAccessControlStrategy}) preserves
 * the existing Vendure permission behavior and performs no row-level filtering.
 * Custom strategies should extend the default class and override the methods
 * they need.
 *
 * **Row-level interception points** (only active when `applyAccessControl` is implemented):
 * - `ListQueryBuilder.build()` — all paginated list queries
 * - `TransactionalConnection.findOneInChannel()` / `findByIdsInChannel()`
 * - `TransactionalConnection.getRepository()` — Proxy intercepts `find`, `findOne`,
 *   `findOneOrFail`, `findAndCount`, and `count`
 *
 * @example
 * ```ts
 * // Override gate-level permissions per channel (#2051 use case)
 * class B2BAccessControlStrategy extends DefaultEntityAccessControlStrategy {
 *     async evaluateAccess(ctx: RequestContext, permissions: Permission[]) {
 *         if (permissions.includes(Permission.Public)
 *             && ctx.channel.customFields.requireAuthentication) {
 *             return ctx.activeUserId != null;
 *         }
 *         return super.evaluateAccess(ctx, permissions);
 *     }
 * }
 * ```
 *
 * @example
 * ```ts
 * // Seller-scoped row-level filtering with async pre-loading
 * class SellerScopedStrategy extends DefaultEntityAccessControlStrategy {
 *     private sellerIds = new WeakMap<RequestContext, ID[]>();
 *     private connection: TransactionalConnection;
 *
 *     init(injector: Injector) {
 *         this.connection = injector.get(TransactionalConnection);
 *     }
 *
 *     async evaluateAccess(ctx: RequestContext, permissions: Permission[]) {
 *         const allowed = await super.evaluateAccess(ctx, permissions);
 *         if (!allowed) return false;
 *
 *         // Pre-load seller data (use rawConnection to avoid Proxy recursion)
 *         if (ctx.activeUserId && !ctx.userHasPermissions([Permission.SuperAdmin])) {
 *             const ids = await this.lookupSellerIds(ctx);
 *             this.sellerIds.set(ctx, ids);
 *         }
 *         return true;
 *     }
 *
 *     applyAccessControl(qb, entityType, ctx) {
 *         const ids = this.sellerIds.get(ctx);
 *         if (!ids) return;
 *         if (entityType === Product) {
 *             qb.innerJoin(`${qb.alias}.channels`, '__acl_ch')
 *                .andWhere('__acl_ch.sellerId IN (:...aclSellerIds)', {
 *                    aclSellerIds: ids,
 *                });
 *         }
 *     }
 * }
 * ```
 *
 * :::info
 *
 * This is configured via the `authOptions.entityAccessControlStrategy` property
 * of your VendureConfig.
 *
 * :::
 *
 * @docsCategory auth
 * @since 3.3.0
 */
export interface EntityAccessControlStrategy extends InjectableStrategy {
    /**
     * @description
     * Called once per request in the AuthGuard to determine whether the request
     * should be allowed. This replaces the default Vendure permission evaluation
     * logic, giving full control over gate-level access.
     *
     * This method can also be used to pre-load data (via `WeakMap<RequestContext>`)
     * for use in the synchronous `applyAccessControl()` method.
     *
     * The {@link DefaultEntityAccessControlStrategy} implements the standard
     * Vendure permission logic. Custom strategies should extend it and call
     * `super.evaluateAccess()` to preserve the default behavior.
     *
     * **Important:** Any database queries in this method should use
     * `rawConnection.getRepository()` rather than the RequestContext-aware
     * `getRepository(ctx, ...)`, since the latter triggers the access
     * control Proxy and can cause infinite recursion.
     *
     * @param ctx - The current RequestContext
     * @param permissions - The permissions required by the `@Allow()` decorator
     * @returns `true` to allow the request, `false` to deny with ForbiddenError
     */
    evaluateAccess(ctx: RequestContext, permissions: Permission[]): Promise<boolean>;

    /**
     * @description
     * Apply row-level access control constraints to the given query builder.
     * This method is called **synchronously** for every entity query that goes
     * through the Vendure data access layer.
     *
     * This is optional. When not implemented, no row-level filtering is applied
     * and no Proxy is created on `getRepository()` — giving zero overhead for
     * the default case.
     *
     * If your access control logic requires async lookups, perform them in
     * `evaluateAccess()` and read the cached results here.
     *
     * @param qb - The TypeORM SelectQueryBuilder to modify
     * @param entityType - The entity class being queried
     * @param ctx - The current RequestContext
     */
    applyAccessControl?<T extends VendureEntity>(
        qb: SelectQueryBuilder<T>,
        entityType: new (...args: any[]) => T,
        ctx: RequestContext,
    ): void;
}
