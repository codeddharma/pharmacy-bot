import { ShieldAlert } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { AppShell } from "./components/AppShell";
import { EmptyState, Spinner } from "./components/ui/layout";
import { AuthProvider, useAuth } from "./lib/auth";
import { LiveProvider } from "./lib/live";
import type { Permission } from "./lib/types";
import { LoginPage } from "./pages/Login";

/**
 * Each page loads when first opened, so the login screen and phone views stay light.
 * After a deploy, an open tab may ask for page files that no longer exist; reload once
 * to pick up the new version instead of showing an error.
 */
function page<T>(load: () => Promise<T>): Promise<T> {
  return load()
    .then((m) => {
      sessionStorage.removeItem("dd-reloaded");
      return m;
    })
    .catch((err) => {
      if (!sessionStorage.getItem("dd-reloaded")) {
        sessionStorage.setItem("dd-reloaded", "1");
        window.location.reload();
        return new Promise<T>(() => undefined);
      }
      throw err;
    });
}
const ActivityPage = lazy(() => page(() => import("./pages/Activity")).then((m) => ({ default: m.ActivityPage })));
const AgentsPage = lazy(() => page(() => import("./pages/Agents")).then((m) => ({ default: m.AgentsPage })));
const CustomersPage = lazy(() => page(() => import("./pages/Customers")).then((m) => ({ default: m.CustomersPage })));
const DeliveriesPage = lazy(() => page(() => import("./pages/Deliveries")).then((m) => ({ default: m.DeliveriesPage })));
const InboxPage = lazy(() => page(() => import("./pages/Inbox")).then((m) => ({ default: m.InboxPage })));
const InteractionsPage = lazy(() => page(() => import("./pages/Interactions")).then((m) => ({ default: m.InteractionsPage })));
const InventoryPage = lazy(() => page(() => import("./pages/Inventory")).then((m) => ({ default: m.InventoryPage })));
const OrdersPage = lazy(() => page(() => import("./pages/Orders")).then((m) => ({ default: m.OrdersPage })));
const OverviewPage = lazy(() => page(() => import("./pages/Overview")).then((m) => ({ default: m.OverviewPage })));
const ProfilePage = lazy(() => page(() => import("./pages/Profile")).then((m) => ({ default: m.ProfilePage })));
const QuestionsPage = lazy(() => page(() => import("./pages/Questions")).then((m) => ({ default: m.QuestionsPage })));
const SettingsPage = lazy(() => page(() => import("./pages/Settings")).then((m) => ({ default: m.SettingsPage })));
const StaffPage = lazy(() => page(() => import("./pages/Staff")).then((m) => ({ default: m.StaffPage })));

function Guard({ perms, children }: { perms: Permission[]; children: ReactNode }) {
  const { can } = useAuth();
  if (perms.length > 0 && !can(...perms)) {
    return <EmptyState icon={<ShieldAlert />} title="You don't have access to this page" description="Ask an admin to give your role this permission." />;
  }
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

/** Each role lands on the first page it can use: agents on their deliveries, pharmacists on questions. */
function Home() {
  const { can } = useAuth();
  if (can("stats.view")) {
    return (
      <Guard perms={["stats.view"]}>
        <OverviewPage />
      </Guard>
    );
  }
  if (can("deliveries.own")) return <Navigate to="/deliveries" replace />;
  if (can("consultations.view")) return <Navigate to="/questions" replace />;
  if (can("orders.view")) return <Navigate to="/orders" replace />;
  if (can("inventory.view")) return <Navigate to="/inventory" replace />;
  return <Navigate to="/profile" replace />;
}

function Protected() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return (
    <LiveProvider>
      <AppShell />
    </LiveProvider>
  );
}

function RouteError() {
  return (
    <div className="grid h-full place-items-center p-6">
      <EmptyState
        icon={<ShieldAlert />}
        title="Something went wrong on this page"
        description="Reload the page. If it keeps happening, tell your admin what you were doing."
        action={
          <button type="button" className="text-sm text-primary underline" onClick={() => window.location.reload()}>
            Reload
          </button>
        }
      />
    </div>
  );
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <Protected />,
    errorElement: <RouteError />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/orders", element: <Guard perms={["orders.view"]}><OrdersPage /></Guard> },
      { path: "/deliveries", element: <Guard perms={["deliveries.own"]}><DeliveriesPage /></Guard> },
      { path: "/inbox", element: <Guard perms={["inbox.view"]}><InboxPage /></Guard> },
      { path: "/questions", element: <Guard perms={["consultations.view"]}><QuestionsPage /></Guard> },
      { path: "/inventory", element: <Guard perms={["inventory.view"]}><InventoryPage /></Guard> },
      { path: "/interactions", element: <Guard perms={["inventory.view"]}><InteractionsPage /></Guard> },
      { path: "/customers", element: <Guard perms={["customers.view"]}><CustomersPage /></Guard> },
      { path: "/agents", element: <Guard perms={["orders.view"]}><AgentsPage /></Guard> },
      { path: "/staff", element: <Guard perms={["users.manage", "roles.manage"]}><StaffPage /></Guard> },
      { path: "/settings", element: <Guard perms={["settings.manage"]}><SettingsPage /></Guard> },
      { path: "/activity", element: <Guard perms={["audit.view"]}><ActivityPage /></Guard> },
      { path: "/profile", element: <Guard perms={[]}><ProfilePage /></Guard> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
