import { Injectable, UnauthorizedException } from "@nestjs/common";
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
}
