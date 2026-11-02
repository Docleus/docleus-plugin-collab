import type { Kysely } from "kysely";
import type { Context, EditorSchemaDescription, Migration } from "@docleus/sdk";
import { parseSchemaDescription, PLUGIN_NAME } from "../shared/index.ts";

interface CollabDocumentsTable {
  name: string;
  space_id: string;
  branch: string;
  entry_id: string;
  /** A Yjs update with the whole document, base64. */
  state: string;
  /** The revision the document was last synced to. */
  revision: string;
  /** The editor schema description the document was encoded with, JSON. */
  schema: string;
  updated_at: number;
}

interface CollabSchema {
  collab_documents: CollabDocumentsTable;
}

export const collabMigrations: readonly Migration[] = [
  {
    id: "0001-create-tables",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<CollabSchema>;
      await typed.schema
        .createTable("collab_documents")
        .addColumn("name", "text", (c) => c.primaryKey())
        .addColumn("space_id", "text", (c) => c.notNull())
        .addColumn("branch", "text", (c) => c.notNull())
        .addColumn("entry_id", "text", (c) => c.notNull())
        .addColumn("state", "text", (c) => c.notNull())
        .addColumn("revision", "text", (c) => c.notNull())
        .addColumn("schema", "text", (c) => c.notNull())
        .addColumn("updated_at", "integer", (c) => c.notNull())
        .execute();
      await typed.schema
        .createIndex("collab_documents_branch")
        .on("collab_documents")
        .columns(["space_id", "branch"])
        .execute();
    },
  },
];

/** A shared document as stored. */
export interface StoredDocument {
  readonly name: string;
  readonly spaceId: string;
  readonly branch: string;
  readonly entryId: string;
  readonly state: Uint8Array;
  readonly revision: string;
  readonly schema: EditorSchemaDescription;
}

export interface CollabStore {
  get(name: string): Promise<StoredDocument | undefined>;
  put(document: StoredDocument): Promise<void>;
  remove(name: string): Promise<void>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createCollabStore(
  ctx: Context,
  now: () => number,
): CollabStore {
  const db = ctx.storage.db as unknown as Kysely<CollabSchema>;
  const ready = ctx.storage.migrate(PLUGIN_NAME, collabMigrations);
  const logger = ctx.logger("collab");

  return {
    async get(name) {
      await ready;
      const row = await db
        .selectFrom("collab_documents")
        .selectAll()
        .where("name", "=", name)
        .executeTakeFirst();
      if (!row) return undefined;
      const schema = parseSchemaDescription(parseJson(row.schema));
      if (!schema) {
        logger.warn("shared document %s has an invalid schema; dropped", name);
        return undefined;
      }
      return {
        name: row.name,
        spaceId: row.space_id,
        branch: row.branch,
        entryId: row.entry_id,
        state: Buffer.from(row.state, "base64"),
        revision: row.revision,
        schema,
      };
    },
    async put(document) {
      await ready;
      const row = {
        state: Buffer.from(document.state).toString("base64"),
        revision: document.revision,
        schema: JSON.stringify(document.schema),
        updated_at: now(),
      };
      await db
        .insertInto("collab_documents")
        .values({
          name: document.name,
          space_id: document.spaceId,
          branch: document.branch,
          entry_id: document.entryId,
          ...row,
        })
        .onConflict((oc) => oc.column("name").doUpdateSet(row))
        .execute();
    },
    async remove(name) {
      await ready;
      await db
        .deleteFrom("collab_documents")
        .where("name", "=", name)
        .execute();
    },
  };
}
