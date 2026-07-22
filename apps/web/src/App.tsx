import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./lib/auth";
import Login from "./pages/Login";
import AppShell from "./components/AppShell";
import Overview from "./pages/Overview";
import Rfqs from "./pages/Rfqs";
import Orders from "./pages/Orders";
import Workshops from "./pages/Workshops";
import Vendors from "./pages/Vendors";
import Users from "./pages/Users";
import Settings from "./pages/Settings";
import Workspaces from "./pages/admin/Workspaces";
import { PageHeader, ComingSoon } from "./components/ui";
import { internalNav } from "./nav";

/** Honest placeholder for sections not yet wired. */
function Placeholder() {
  const { pathname } = useLocation();
  const label = internalNav.flatMap((g) => g.items).find((i) => i.path === pathname)?.label ?? pathname.replace("/", "");
  return (
    <>
      <PageHeader title={label} />
      <ComingSoon title={label} />
    </>
  );
}

const WIRED = ["/overview", "/rfqs", "/orders", "/org/workshops", "/vendors", "/admin/users", "/admin/workspaces"];

export default function App() {
  const { authed } = useAuth();
  if (!authed) return <Login />;

  const placeholders = internalNav.flatMap((g) => g.items).filter((i) => !WIRED.includes(i.path));

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/overview" element={<Overview />} />
        <Route path="/rfqs" element={<Rfqs />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/org/workshops" element={<Workshops />} />
        <Route path="/vendors" element={<Vendors />} />
        <Route path="/admin/users" element={<Users />} />
        <Route path="/admin/workspaces" element={<Workspaces />} />
        <Route path="/settings" element={<Settings />} />
        {placeholders.map((p) => (
          <Route key={p.path} path={p.path} element={<Placeholder />} />
        ))}
        <Route path="/developers" element={<Placeholder />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
  );
}
