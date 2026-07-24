import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./lib/auth";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import AppShell from "./components/AppShell";
import Overview from "./pages/Overview";
import Rfqs from "./pages/Rfqs";
import RfqDetail from "./pages/RfqDetail";
import Orders from "./pages/Orders";
import Workshops from "./pages/Workshops";
import WorkshopDetail from "./pages/WorkshopDetail";
import Vendors from "./pages/Vendors";
import Providers from "./pages/Providers";
import InternalDashboard from "./pages/InternalDashboard";
import ManagementOverview from "./pages/ManagementOverview";
import Users from "./pages/Users";
import Onboarding from "./pages/Onboarding";
import OnboardingReview from "./pages/OnboardingReview";
import VendorOverview from "./pages/vendor/VendorOverview";
import VendorQuotations from "./pages/vendor/VendorQuotations";
import VendorQuotationDetail from "./pages/vendor/VendorQuotationDetail";
import VendorProfile from "./pages/vendor/VendorProfile";
import VendorConfirmedOrders from "./pages/vendor/VendorConfirmedOrders";
import WorkshopOverview from "./pages/workshop/WorkshopOverview";
import WorkshopBranches from "./pages/workshop/WorkshopBranches";
import WorkshopOrders from "./pages/workshop/WorkshopOrders";
import WorkshopRequests from "./pages/workshop/WorkshopRequests";
import WorkshopNewRequest from "./pages/workshop/WorkshopNewRequest";
import WorkshopRequestDetail from "./pages/workshop/WorkshopRequestDetail";
import Settings from "./pages/Settings";
import Workspaces from "./pages/admin/Workspaces";
import WorkspaceDetail from "./pages/admin/WorkspaceDetail";
import { PageHeader, ComingSoon, Spinner } from "./components/ui";
import { platformNav, workspaceNav, vendorNav, workshopNav, providerNav, navForPersona } from "./nav";

const ALL_ITEMS = [...platformNav, ...workspaceNav, ...vendorNav, ...workshopNav, ...providerNav].flatMap((g) => g.items);

/** Honest placeholder for sections not yet wired. Labels resolve from the active persona's nav
 *  (a path can appear in more than one persona with a different label). */
function Placeholder() {
  const { pathname } = useLocation();
  const { me } = useAuth();
  const personaItems = me
    ? navForPersona(me.persona, {
        isSuperAdmin: me.platformRole === "super_admin",
        isCompanyAdmin: me.role === "company_admin",
      }).flatMap((g) => g.items)
    : [];
  const label =
    personaItems.find((i) => i.path === pathname)?.label ??
    ALL_ITEMS.find((i) => i.path === pathname)?.label ??
    pathname.replace(/^\//, "");
  return (
    <>
      <PageHeader title={label} />
      <ComingSoon title={label} />
    </>
  );
}

const WIRED = new Set([
  "/overview",
  "/rfqs",
  "/orders",
  "/org/workshops",
  "/vendors",
  "/providers",
  "/internal",
  "/management-overview",
  "/admin/users",
  "/admin/workspaces",
  "/onboarding",
  "/onboarding/review",
  "/vendor",
  "/vendor/quotations",
  "/vendor/confirmed",
  "/vendor/profile",
  "/workshop",
  "/workshop/requests",
  "/workshop/requests/new",
  "/workshop/branches",
  "/workshop/orders",
  "/settings",
]);

export default function App() {
  const { authed, me, activeSlug } = useAuth();
  // Unauthenticated: /signup shows the self-registration page, everything else the login page.
  if (!authed) return typeof window !== "undefined" && window.location.pathname === "/signup" ? <Signup /> : <Login />;
  // wait for the persona to resolve before routing, so vendors land on /vendor not /overview
  if (!me) return <div className="grid h-full place-items-center"><Spinner label="Loading…" /></div>;

  // Platform staff with no workspace selected run the system view; their home is Workspaces.
  const systemMode = me.isInternal && !activeSlug;
  const home = me.persona === "vendor"
    ? "/vendor"
    : me.persona === "workshop"
      ? "/workshop"
      : me.persona === "service_provider"
        ? "/provider"
        : systemMode
          ? "/admin/workspaces"
          : "/overview";
  // one placeholder route per unwired path (a path can appear in several persona navs)
  const seenPaths = new Set(WIRED);
  const placeholders = ALL_ITEMS.filter((i) => (seenPaths.has(i.path) ? false : (seenPaths.add(i.path), true)));

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/overview" element={systemMode ? <Navigate to="/admin/workspaces" replace /> : <Overview />} />
        <Route path="/rfqs" element={<Rfqs />} />
        <Route path="/rfqs/:id" element={<RfqDetail />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/org/workshops" element={<Workshops />} />
        <Route path="/org/workshops/:id" element={<WorkshopDetail />} />
        <Route path="/vendors" element={<Vendors />} />
        <Route path="/providers" element={<Providers />} />
        <Route path="/internal" element={<InternalDashboard />} />
        <Route path="/management-overview" element={<ManagementOverview />} />
        <Route path="/admin/users" element={<Users />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/onboarding/review" element={<OnboardingReview />} />
        <Route path="/vendor" element={<VendorOverview />} />
        <Route path="/vendor/quotations" element={<VendorQuotations />} />
        <Route path="/vendor/quotations/:id" element={<VendorQuotationDetail />} />
        <Route path="/vendor/profile" element={<VendorProfile />} />
        <Route path="/vendor/confirmed" element={<VendorConfirmedOrders />} />
        <Route path="/workshop" element={<WorkshopOverview />} />
        <Route path="/workshop/requests" element={<WorkshopRequests />} />
        <Route path="/workshop/requests/new" element={<WorkshopNewRequest />} />
        <Route path="/workshop/requests/:id" element={<WorkshopRequestDetail />} />
        <Route path="/workshop/branches" element={<WorkshopBranches />} />
        <Route path="/workshop/orders" element={<WorkshopOrders />} />
        <Route path="/admin/workspaces" element={<Workspaces />} />
        <Route path="/admin/workspaces/:id" element={<WorkspaceDetail />} />
        <Route path="/settings" element={<Settings />} />
        {placeholders.map((p) => (
          <Route key={p.path} path={p.path} element={<Placeholder />} />
        ))}
        <Route path="/developers" element={<Placeholder />} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Route>
    </Routes>
  );
}
