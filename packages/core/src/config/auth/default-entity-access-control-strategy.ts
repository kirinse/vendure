import { Permission } from '@vendure/common/lib/generated-types';

import { RequestContext } from '../../api/common/request-context';

import { EntityAccessControlStrategy } from './entity-access-control-strategy';

/**
 * @description
 * The default EntityAccessControlStrategy which implements the standard
 * Vendure permission evaluation logic. It checks the `@Allow()` decorator
 * permissions against the current user's channel permissions.
 *
 * Custom strategies should extend this class and override `evaluateAccess()`
 * to customize gate-level permissions, and/or implement `applyAccessControl()`
 * to add row-level filtering.
 *
 * @example
 * ```ts
 * class MyStrategy extends DefaultEntityAccessControlStrategy {
 *     async evaluateAccess(ctx: RequestContext, permissions: Permission[]) {
 *         // Custom gate-level logic, falling back to default
 *         return super.evaluateAccess(ctx, permissions);
 *     }
 *
 *     applyAccessControl(qb, entityType, ctx) {
 *         // Row-level filtering
 *     }
 * }
 * ```
 *
 * @docsCategory auth
 * @since 3.3.0
 */
export class DefaultEntityAccessControlStrategy implements EntityAccessControlStrategy {
    /**
     * @description
     * Implements the standard Vendure permission evaluation:
     * - No permissions required (`@Allow()` not set) → allow
     * - `Permission.Public` → allow
     * - Otherwise, check `ctx.userHasPermissions()` or `ctx.authorizedAsOwnerOnly`
     */
    async evaluateAccess(ctx: RequestContext, permissions: Permission[]): Promise<boolean> {
        if (permissions.length === 0) {
            return true;
        }
        if (permissions.includes(Permission.Public)) {
            return true;
        }
        return ctx.userHasPermissions(permissions) || ctx.authorizedAsOwnerOnly;
    }

    // No applyAccessControl — no row-level filtering, no Proxy overhead
}
