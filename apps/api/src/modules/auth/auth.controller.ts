import { Body, Controller, Post } from "@nestjs/common";
import { AuthService, loginSchema } from "./auth.service.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  login(@Body() body: unknown) {
    return this.auth.login(loginSchema.parse(body));
  }
}
