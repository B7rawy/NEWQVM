import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import Login from "./pages/Login";
import AppShell from "./components/AppShell";
import Rfqs from "./pages/Rfqs";
import Orders from "./pages/Orders";

export default function App() {
  const { authed } = useAuth();
  if (!authed) return <Login />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/rfqs" element={<Rfqs />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="*" element={<Navigate to="/rfqs" replace />} />
      </Route>
    </Routes>
  );
}
