import { Args, Query, Resolver } from '@nestjs/graphql';
import {
    Ctx,
    ID,
    PluginCommonModule,
    Product,
    RequestContext,
    TransactionalConnection,
    VendurePlugin,
} from '@vendure/core';
import gql from 'graphql-tag';

@Resolver()
class EntityAccessControlTestResolver {
    constructor(private connection: TransactionalConnection) {}

    /**
     * Uses getRepository(ctx, Product).find() directly — exercises the Proxy path.
     */
    @Query()
    async rawRepositoryProductIds(@Ctx() ctx: RequestContext): Promise<string[]> {
        const products = await this.connection.getRepository(ctx, Product).find({
            order: { id: 'ASC' },
        });
        return products.map(p => p.id.toString());
    }

    /**
     * Uses getRepository(ctx, Product).findOne() directly — exercises the Proxy path.
     */
    @Query()
    async rawRepositoryProduct(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<{ id: string } | null> {
        const product = await this.connection.getRepository(ctx, Product).findOne({
            where: { id: args.id },
        });
        return product ? { id: product.id.toString() } : null;
    }

    /**
     * Uses getRepository(ctx, Product).findAndCount() — exercises the Proxy path.
     */
    @Query()
    async rawRepositoryProductFindAndCount(@Ctx() ctx: RequestContext): Promise<number> {
        const [items, count] = await this.connection.getRepository(ctx, Product).findAndCount({
            order: { id: 'ASC' },
        });
        return count;
    }

    /**
     * Uses getRepository(ctx, Product).count() — exercises the Proxy path.
     */
    @Query()
    async rawRepositoryProductCount(@Ctx() ctx: RequestContext): Promise<number> {
        return this.connection.getRepository(ctx, Product).count();
    }
}

@VendurePlugin({
    imports: [PluginCommonModule],
    adminApiExtensions: {
        schema: gql`
            extend type Query {
                rawRepositoryProductIds: [String!]!
                rawRepositoryProduct(id: ID!): JSON
                rawRepositoryProductFindAndCount: Int!
                rawRepositoryProductCount: Int!
            }
        `,
        resolvers: [EntityAccessControlTestResolver],
    },
})
export class EntityAccessControlTestPlugin {}
