// Canonical role + user-type definitions, shared by api (guards + RLS mapping) and web (UI gating).
// These replace the old integer list_data ids (170/171/172…) with explicit, self-documenting enums.

/** Where a user sits in the platform. */
export enum UserScope {
  /** Qparts internal staff — can see across all tenants (subject to internal-staff RLS policy). */
  Platform = "platform",
  /** Belongs to a single client company (tenant). */
  Company = "company",
  /** External supplier. */
  Vendor = "vendor",
}

/** Platform-level roles (Qparts side). */
export enum PlatformRole {
  SuperAdmin = "super_admin",
  Staff = "staff",
  AccountManager = "account_manager",
  Purchasing = "purchasing",
  PartExtractor = "part_extractor",
}

/** Company-level roles (client workshop side). */
export enum CompanyRole {
  CompanyAdmin = "company_admin",
  BranchManager = "branch_manager",
  ServiceAdvisor = "service_advisor",
}

/** Vendor-level roles. */
export enum VendorRole {
  VendorAdmin = "vendor_admin",
  VendorUser = "vendor_user",
}

export type AnyRole = PlatformRole | CompanyRole | VendorRole;
