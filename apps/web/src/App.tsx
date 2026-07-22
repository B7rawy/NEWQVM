import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./lib/auth";
import Login from "./pages/Login";
import AppShell from "./components/AppShell";
import Overview from "./pages/Overview";
import Rfqs from "./pages/Rfqs";
import RfqDetail from "./pages/RfqDetail";
import Orders from "./pages/Orders";
import Workshops from "./pages/Workshops";
import Vendors from "./pages/Vendors";
import Users from "./pages/Users";
import Settings from "./pages/Settings";
import Workspaces from "./pages/admin/Workspaces";
import WorkspaceDetail from "./pages/admin/WorkspaceDetail";
import { PageHeader, ComingSoon, Spinner } from "./components/ui";
import { platformNav, workspaceNav, vendorNav } from "./nav";

const ALL_ITEMS = [...platformNav, ...workspaceNav, ...vendorNav].flatMap((g) => g.items);

/** Honest placeholder for sections not yet wired. */
function Placeholder() {
  const { pathname } = useLocation();
  const label = ALL_ITEMS.find((i) => i.path === pathname)?.label ?? pathname.replace(/^\//, "");
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
  "/admin/users",
  "/admin/workspaces",
  "/settings",
]);

export default function App() {
  const { authed, me } = useAuth();
  if (!authed) return <Login />;
  // wait for the persona to resolve before routing, so vendors land on /vendor not /overview
  if (!me) return <div className="grid h-full place-items-center"><Spinner label="Loading…" /></div>;

  const home = me.persona === "vendor" ? "/vendor" : "/overview";
  const placeholders = ALL_ITEMS.filter((i) => !WIRED.has(i.path));

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/overview" element={<Overview />} />
        <Route path="/rfqs" element={<Rfqs />} />
        <Route path="/rfqs/:id" element={<RfqDetail />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/org/workshops" element={<Workshops />} />
        <Route path="/vendors" element={<Vendors />} />
        <Route path="/admin/users" element={<Users />} />
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
