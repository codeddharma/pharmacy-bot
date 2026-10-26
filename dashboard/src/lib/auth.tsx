import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";
import { api, ApiError, post } from "./api";
import type { Me, Permission } from "./types";

interface AuthValue {
  user: Me | null;
  loading: boolean;
  can: (...perms: Permission[]) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return (await api<{ user: Me }>("/auth/me")).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    const onLoggedOut = () => qc.setQueryData(["me"], null);
    window.addEventListener("dd:logged-out", onLoggedOut);
    return () => window.removeEventListener("dd:logged-out", onLoggedOut);
  }, [qc]);

  const user = me.data ?? null;
  const can = useCallback((...perms: Permission[]) => !!user && perms.some((p) => user.permissions.includes(p)), [user]);

  const value: AuthValue = {
    user,
    loading: me.isLoading,
    can,
    login: async (email, password) => {
      await post("/auth/login", { email, password });
      qc.clear();
      await me.refetch();
    },
    logout: async () => {
      await post("/auth/logout").catch(() => undefined);
      qc.clear();
      qc.setQueryData(["me"], null);
    },
    refresh: () => void me.refetch(),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
