import { useQuery } from "@tanstack/react-query";
import { Truck } from "lucide-react";
import { Link } from "react-router";
import { Badge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, PageHeader, Skeleton, Table, Td, Th } from "@/components/ui/layout";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Agent } from "@/lib/types";
import { phone } from "@/lib/utils";

export function AgentsPage() {
  const { can } = useAuth();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: Agent[] }>("/agents"), refetchInterval: 60_000 });

  return (
    <>
      <PageHeader
        title="Delivery agents"
        description="Who's on duty and how many deliveries each person has. Agents log in on their phone to see their deliveries."
        actions={can("users.manage") ? <Button variant="secondary" asChild><Link to="/staff">Add or edit agents</Link></Button> : null}
      />
      <Card>
        {agents.isLoading ? (
          <Skeleton className="m-4 h-24" />
        ) : agents.data?.agents.length === 0 ? (
          <EmptyState icon={<Truck />} title="No delivery agents yet" description='Add staff with the "Delivery agent" role on the Staff page.' />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Agent</Th>
                <Th>Phone</Th>
                <Th>Vehicle</Th>
                <Th>Status</Th>
                <Th className="text-right">On the way / to deliver</Th>
                <Th className="text-right">Delivered today</Th>
              </tr>
            </thead>
            <tbody>
              {agents.data?.agents.map((a) => (
                <tr key={a.id}>
                  <Td className="font-medium">{a.name}</Td>
                  <Td>
                    {a.phone ? (
                      <a href={`tel:${a.phone}`} className="text-primary">
                        {phone(a.phone)}
                      </a>
                    ) : (
                      "–"
                    )}
                  </Td>
                  <Td className="text-muted">{a.vehicle ?? "–"}</Td>
                  <Td>{a.onDuty ? <Badge tone="green">On duty</Badge> : <Badge>Off duty</Badge>}</Td>
                  <Td className="tabular text-right">{a.activeOrders}</Td>
                  <Td className="tabular text-right">{a.deliveredToday}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
