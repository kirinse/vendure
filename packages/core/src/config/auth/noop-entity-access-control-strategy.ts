import { EntityAccessControlStrategy } from './entity-access-control-strategy';

/**
 * @description
 * The default EntityAccessControlStrategy which applies no access control
 * restrictions. All entities are visible to all users.
 *
 * @docsCategory auth
 * @since 3.3.0
 */
export class NoopEntityAccessControlStrategy implements EntityAccessControlStrategy {
    applyAccessControl(): void {
        // no-op
    }
}
