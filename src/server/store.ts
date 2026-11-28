import type { Kysely } from "kysely";
import {
  DocleusError,
  z,
  type Context,
  type EditorSchemaDescription,
  type Migration,
} from "@docleus/sdk";
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
  author: string | null;
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
  {
    id: "0002-document-author",
    async up(db: Kysely<unknown>) {
      await db.schema
        .alterTable("collab_documents")
        .addColumn("author", "text")
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
  readonly author: string | undefined;
}

export interface CollabStore {
  get(name: string): Promise<StoredDocument | undefined>;
  list(spaceId: string, branch: string): Promise<readonly StoredDocument[]>;
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

const storedRow = z.object({
  name: z.string().min(1),
  space_id: z.string().min(1),
  branch: z.string().min(1),
  entry_id: z.string().min(1),
  state: z.string().min(1),
  revision: z.string().min(1),
  schema: z.string(),
  author: z.string().min(1).nullable(),
});

function readDocument(value: unknown): StoredDocument {
  const parsed = storedRow.safeParse(value);
  const schema =
    parsed.success && parseSchemaDescription(parseJson(parsed.data.schema));
  if (!parsed.success || !schema) {
    throw new DocleusError(
      "collab/invalid-stored-document",
      "a stored shared document is malformed",
    );
  }
  const row = parsed.data;
  return {
    name: row.name,
    spaceId: row.space_id,
    branch: row.branch,
    entryId: row.entry_id,
    state: Buffer.from(row.state, "base64"),
    revision: row.revision,
    schema,
    author: row.author ?? undefined,
  };
}

export function createCollabStore(
  ctx: Context,
  now: () => number,
): CollabStore {
  const db = ctx.storage.db as unknown as Kysely<CollabSchema>;
  const ready = ctx.storage.migrate(PLUGIN_NAME, collabMigrations);

  return {
    async get(name) {
      await ready;
      const row = await db
        .selectFrom("collab_documents")
        .selectAll()
        .where("name", "=", name)
        .executeTakeFirst();
      return row && readDocument(row);
    },
    async list(spaceId, branch) {
      await ready;
      const rows = await db
        .selectFrom("collab_documents")
        .selectAll()
        .where("space_id", "=", spaceId)
        .where("branch", "=", branch)
        .orderBy("name")
        .execute();
      return rows.map(readDocument);
    },
    async put(document) {
      await ready;
      const row = {
        state: Buffer.from(document.state).toString("base64"),
        revision: document.revision,
        schema: JSON.stringify(document.schema),
        author: document.author ?? null,
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
