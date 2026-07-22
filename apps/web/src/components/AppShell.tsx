import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function AppShell() {
  const { me, workspaces, activeSlug, switchWorkspace, logout } = useAuth();
  const active = workspaces.find((w) => w.slug === activeSlug);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">QVM<span>·</span></div>
        <nav>
          <NavLink to="/rfqs" className={({ isActive }) => (isActive ? "active" : "")}>RFQs</NavLink>
          <NavLink to="/orders" className={({ isActive }) => (isActive ? "active" : "")}>Orders</NavLink>
        </nav>
        <div className="spacer" />
        <div className="ws-switch">
          {active?.is_sandbox && <span className="badge" style={{ background: "#fff2cc" }}>SANDBOX</span>}
          <select
            value={activeSlug ?? ""}
            onChange={(e) => switchWorkspace(e.target.value)}
            title="Switch workspace"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.slug}>
                {w.name}
                {w.is_sandbox ? " (sandbox)" : ""}
              </option>
            ))}
          </select>
        </div>
        <span className="who">
          {me?.user?.full_name}
          {me?.isInternal ? " · staff" : me?.role ? ` · ${me.role}` : ""}
        </span>
        <button onClick={logout} style={{ background: "transparent", color: "#cfe0e6", borderColor: "transparent" }}>
          Sign out
        </button>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
