import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";

/**
 * Shared part-number cleaner (QNEW-34) — ONE utility used everywhere a part number is entered
 * (purchasing form, vendor portal, Excel upload, invoice OCR), so the same part isn't stored in
 * different formats. Rules: trim, uppercase, normalize every separator run — whitespace, . / _ and
 * '-' — to a single '-', then strip leading/trailing dashes. (So "12 34" and "12-34" collapse alike.)
 */
export function cleanPartNumber(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s./_-]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const createPartSchema = z.object({
  nameEn: z.string().min(1).max(120).optional(),
  nameAr: z.string().min(1).max(120).optional(),
  partCategoryId: z.string().uuid().optional(),
  synonyms: z.array(z.string().min(1).max(120)).optional(),
});
export type CreatePartDto = z.infer<typeof createPartSchema>;

@Injectable()
export class PartsService {
  constructor(private readonly dbService: DbService) {}

  /** Admin adds a canonical part (+ optional synonyms). source = direct_admin. */
  async create(ctx: RlsContext, dto: CreatePartDto) {
    if (!dto.nameEn && !dto.nameAr) throw new BadRequestException("a part needs a name (ar or en)");
    return this.dbService.withContext(ctx, async (tx) => {
      const [part] = await tx
        .insert(schema.partsMaster)
        .values({
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          partCategoryId: dto.partCategoryId,
          source: "direct_admin",
        })
        .returning({ id: schema.partsMaster.id });

      if (dto.synonyms?.length) {
        await tx
          .insert(schema.partSynonyms)
          .values(dto.synonyms.map((s) => ({ partId: part.id, synonym: s.trim() })))
          .onConflictDoNothing();
      }
      return { id: part.id };
    });
  }

  async addSynonym(ctx: RlsContext, partId: string, synonym: string) {
    const value = synonym.trim();
    return this.dbService.withContext(ctx, async (tx) => {
      // synonym is globally unique: if it already points elsewhere, say so instead of a silent no-op.
      const owner = (await tx.execute(sql`
        select part_id from part_synonyms where synonym = ${value} limit 1`))[0] as { part_id: string } | undefined;
      if (owner && owner.part_id !== partId)
        throw new ConflictException("this synonym already belongs to another part");
      if (!owner) await tx.insert(schema.partSynonyms).values({ partId, synonym: value });
      return { partId, synonym: value };
    });
  }

  /**
   * Auto-detect category from a typed name/synonym (QNEW-33). Exact match on a synonym or the
   * master name → its category. No match → matched:false (caller flags for the admin review queue).
   */
  async detectCategory(ctx: RlsContext, name: string) {
    const q = name.trim().toLowerCase();
    const row = (
      await this.dbService.withContext(ctx, (tx) =>
        tx.execute(sql`
          select pm.id as part_id, pm.part_category_id, pc.label_en as category
          from parts_master pm
          left join part_categories pc on pc.id = pm.part_category_id
          where lower(pm.name_en) = ${q} or lower(pm.name_ar) = ${q}
             or exists (select 1 from part_synonyms s where s.part_id = pm.id and lower(s.synonym) = ${q})
          limit 1`),
      )
    )[0] as { part_id?: string; part_category_id?: string; category?: string } | undefined;

    if (!row) return { matched: false as const, query: name };
    return {
      matched: true as const,
      partId: row.part_id,
      partCategoryId: row.part_category_id ?? null,
      category: row.category ?? null,
    };
  }

  /** Search master parts by name/synonym (used by RFQ/pricing/vendor screens). */
  async search(ctx: RlsContext, q: string) {
    const like = `%${q.trim().toLowerCase()}%`;
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select distinct pm.id, pm.name_en, pm.name_ar, pc.label_en as category
        from parts_master pm
        left join part_categories pc on pc.id = pm.part_category_id
        left join part_synonyms s on s.part_id = pm.id
        where lower(coalesce(pm.name_en,'')) like ${like}
           or lower(coalesce(pm.name_ar,'')) like ${like}
           or lower(s.synonym) like ${like}
        order by pm.name_en limit 25`),
    );
    return { count: rows.length, parts: rows };
  }
}
