import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    // Keys for the REST API / MCP endpoint. Only a SHA-256 hash of the key is stored.
    return knex.schema.createTable("api_key", (table) => {
        table.increments("id");
        table.string("name", 255).notNullable();
        // First characters of the key, shown in the UI and used to find the key
        table.string("prefix", 32).notNullable().unique();
        table.string("key_hash", 128).notNullable();
        // "read" or "write"
        table.string("permission", 20).notNullable().defaultTo("read");
        table.boolean("active").notNullable().defaultTo(true);
        table.bigInteger("created_at").notNullable();
        table.bigInteger("expires_at").nullable();
        table.bigInteger("last_used_at").nullable();
        table.string("last_used_ip", 64).nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    return knex.schema.dropTable("api_key");
}
