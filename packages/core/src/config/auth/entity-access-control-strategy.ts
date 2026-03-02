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
     * Apply access control constraints to the given query builder. This method
     * is called for every entity query that goes through the Vendure data access
     * layer. Use `qb.andWhere()` to add filtering conditions.
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
