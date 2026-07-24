import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { sql } from "drizzle-orm";
import argon2 from "argon2";
import { z } from "zod";
import { DbService } from "../../db/db.service.js";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginDto = z.infer<typeof loginSchema>;

/** Self-registration (QNEW-71): create a counterparty account that logs in immediately, PENDING
 *  activation. Login is by email; mobile is optional here and becomes the individual identifier. */
export const signupSchema = z.object({
  kind: z.enum(["vendor", "workshop"]),
  fullName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  mobile: z.string().trim().min(6).optional(),
});
export type SignupDto = z.infer<typeof signupSchema>;

@Injectable()
export class AuthService {
  constructor(
    private readonly dbService: DbService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<{ token: string; user: { id: string; fullName: string } }> {
    // login precedes tenant scoping → run as internal to read the global users table.
    const rows = await this.dbService.withContext(
      { tenantId: null, userId: null, isInternal: true },
      (tx) =>
        tx.execute(sql`
          select id, full_name, password_hash, is_active
          from users where email = ${dto.email.toLowerCase()} limit 1`),
    );
    const user = rows[0] as
      | { id: string; full_name: string; password_hash: string | null; is_active: boolean }
      | undefined;

    if (!user || !user.is_active || !user.password_hash) {
      throw new UnauthorizedException("invalid credentials");
    }
    const ok = await argon2.verify(user.password_hash, dto.password).catch(() => false);
    if (!ok) throw new UnauthorizedException("invalid credentials");

    const token = await this.jwt.signAsync({ sub: user.id });
    return { token, user: { id: user.id, fullName: user.full_name } };
  }

  /** Self-register a counterparty: user + a PENDING Individual directory entity + admin link, then
   *  return a token so they log in immediately (QNEW-71 activation gate). Runs internal (global write). */
  async signup(dto: SignupDto): Promise<{ token: string; user: { id: string; fullName: string } }> {
    const email = dto.email.toLowerCase();
    return this.dbService.withContext({ tenantId: null, userId: null, isInternal: true }, async (tx) => {
      const exists = (await tx.execute(sql`select id from users where email = ${email} limit 1`))[0];
      if (exists) throw new ConflictException("email already registered");
      const hash = await argon2.hash(dto.password);
      const [u] = (await tx.execute(sql`
        insert into users (email, full_name, password_hash) values (${email}, ${dto.fullName}, ${hash}) returning id`)) as Array<{ id: string }>;
      try {
        if (dto.kind === "vendor") {
          const [v] = (await tx.execute(sql`
            insert into vendors (legal_name, counterparty_type, activation_status, primary_email, primary_phone, created_by, updated_by)
            values (${dto.fullName}, 'individual', 'pending', ${email}, ${dto.mobile ?? null}, ${u.id}::uuid, ${u.id}::uuid) returning id`)) as Array<{ id: string }>;
          await tx.execute(sql`
            insert into vendor_users (vendor_id, user_id, is_vendor_admin, created_by, updated_by)
            values (${v.id}::uuid, ${u.id}::uuid, true, ${u.id}::uuid, ${u.id}::uuid)`);
        } else {
          const [w] = (await tx.execute(sql`
            insert into workshops (name, counterparty_type, activation_status, primary_email, primary_phone, created_by, updated_by)
            values (${dto.fullName}, 'individual', 'pending', ${email}, ${dto.mobile ?? null}, ${u.id}::uuid, ${u.id}::uuid) returning id`)) as Array<{ id: string }>;
          await tx.execute(sql`
            insert into workshop_users (workshop_id, user_id, is_workshop_admin, created_by, updated_by)
            values (${w.id}::uuid, ${u.id}::uuid, true, ${u.id}::uuid, ${u.id}::uuid)`);
        }
      } catch (e) {
        // an individual with this mobile already exists (scoped partial-unique)
        if ((e as { code?: string })?.code === "23505") throw new ConflictException("this mobile is already registered");
        throw e;
      }
      const token = await this.jwt.signAsync({ sub: u.id });
      return { token, user: { id: u.id, fullName: dto.fullName } };
    });
  }
}
