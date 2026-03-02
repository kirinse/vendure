import { SelectQueryBuilder } from 'typeorm';

import { RequestContext } from '../../api/common/request-context';
import { InjectableStrategy } from '../../common/types/injectable-strategy';
import { VendureEntity } from '../../entity/base/base.entity';

/**
 * @description
 * An EntityAccessControlStrategy allows you to apply row-level access control
 * to entity queries. This is useful for implementing entity-level ACL, where
 * different administrators or customers should only be able to view/access a
 * subset of entities.
 *
 * The strategy is invoked at multiple query interception points:
 * - `ListQueryBuilder.build()` — covers all paginated list queries
 * - `TransactionalConnection.findOneInChannel()` — covers single-entity lookups by channel
 * - `TransactionalConnection.findByIdsInChannel()` — covers batch lookups by channel
 * - `TransactionalConnection.getRepository()` — a Proxy intercepts `find`, `findOne`,
 *   `findOneOrFail`, `findAndCount`, and `count` on the returned repository
 *
 * **Important implementation notes:**
 * - When adding joins or subqueries, always use unique aliases to avoid
 *   collisions with the existing query.
 * - If the strategy only applies to specific entity types, use `entityType`
 *   to check and return early (no-op) for unrelated entities.
 * - The `ctx` parameter provides the current `RequestContext`, which includes
 *   the active user, channel, and API type.
 *
 * @example
 * ```ts
 * // Simple inline filter (no async lookup needed)
 * class MyAccessControlStrategy implements EntityAccessControlStrategy {
 *     applyAccessControl<T extends VendureEntity>(
 *         qb: SelectQueryBuilder<T>,
 *         entityType: new (...args: any[]) => T,
 *         ctx: RequestContext,
 *     ): void {
 *         if (entityType === Product) {
 *             qb.andWhere(`${qb.alias}.ownerId = :userId`, {
 *                 userId: ctx.activeUserId,
 *             });
 *         }
 *     }
 * }
 * ```
 *
 * @example
 * ```ts
 * // Two-phase pattern: async lookup + sync apply
 * class SellerScopedAccessStrategy implements EntityAccessControlStrategy {
 *     private allowedSellerIds = new WeakMap<RequestContext, ID[]>();
 *     private connection: TransactionalConnection;
 *
 *     init(injector: Injector) {
 *         this.connection = injector.get(TransactionalConnection);
 *     }
 *
 *     async prepareAccessControl(ctx: RequestContext) {
 *         // Use rawConnection to avoid triggering access control recursion
 *         const channels = await this.connection.rawConnection
 *             .getRepository(Channel)
 *             .createQueryBuilder('ch')
 *             .innerJoin('ch.roles', 'role')
 *             .innerJoin('role.users', 'user', 'user.id = :userId', {
 *                 userId: ctx.activeUserId,
 *             })
 *             .select('DISTINCT ch.sellerId', 'sellerId')
 *             .getRawMany();
 *         this.allowedSellerIds.set(ctx, channels.map(c => c.sellerId));
 *     }
 *
 *     applyAccessControl(qb, entityType, ctx) {
 *         const sellerIds = this.allowedSellerIds.get(ctx);
 *         if (!sellerIds) return; // No cache entry = no restrictions
 *         if (entityType === Product) {
 *             qb.innerJoin(`${qb.alias}.channels`, '__acl_ch')
 *                .andWhere('__acl_ch.sellerId IN (:...aclSellerIds)', {
 *                    aclSellerIds: sellerIds,
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
     * Called once per request, before any entity queries are executed. Use this
     * to perform async operations such as database lookups or external service
     * calls to determine the current user's access scope. Cache the results
     * (e.g. using a `WeakMap<RequestContext, ...>`) for use in the synchronous
     * `applyAccessControl()` method.
     *
     * This is called in the AuthGuard after the RequestContext has been created.
     *
     * **Important:** Any database queries in this method should use
     * `rawConnection.getRepository()` rather than the RequestContext-aware
     * `getRepository(ctx, ...)`, since the latter would trigger the access
     * control Proxy and cause infinite recursion.
     *
     * @param ctx - The current RequestContext
     */
    prepareAccessControl?(ctx: RequestContext): Promise<void>;

    /**
     * @description
     * Apply access control constraints to the given query builder. This method
     * is called **synchronously** for every entity query that goes through the
     * Vendure data access layer. Use `qb.andWhere()` to add filtering conditions.
     *
     * If your access control logic requires async lookups, perform them in
     * `prepareAccessControl()` and read the cached results here.
     *
     * @param qb - The TypeORM SelectQueryBuilder to modify
     * @param entityType - The entity class being queried
     * @param ctx - The current RequestContext
     */
    applyAccessControl<T extends VendureEntity>(
        qb: SelectQueryBuilder<T>,
        entityType: new (...args: any[]) => T,
        ctx: RequestContext,
    ): void;
}
