import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, PageHeader, Skeleton, Table, Td, Th } from "@/components/ui/layout";
import { api } from "@/lib/api";
import type { AuditEntry } from "@/lib/types";
import { dateTime } from "@/lib/utils";

const label = (a: string) => a.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function ActivityPage() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ["audit", page], queryFn: () => api<{ entries: AuditEntry[] }>(`/audit?page=${page}&pageSize=50`) });
  return (
    <>
      <PageHeader title="Activity log" description="Who did what, and when: staff changes, refused prescription items, payments and logins." />
      <Card>
        {q.isLoading ? (
          <Skeleton className="m-4 h-40" />
        ) : q.data?.entries.length === 0 ? (
          <EmptyState icon={<ScrollText />} title="Nothing logged yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>What</Th>
                <Th>Who</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {q.data?.entries.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap text-muted">{dateTime(e.at)}</Td>
                  <Td>
                    {label(e.action)}
                    {e.entityId ? <span className="text-muted"> · {e.entityId}</span> : null}
                  </Td>
                  <Td>{e.userName ?? (e.customerName ? `Customer: ${e.customerName}` : "System")}</Td>
                  <Td className="max-w-md truncate font-mono text-xs text-muted">{e.data ? JSON.stringify(e.data) : ""}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
          Newer
        </Button>
        <Button variant="secondary" size="sm" disabled={(q.data?.entries.length ?? 0) < 50} onClick={() => setPage(page + 1)}>
          Older
        </Button>
      </div>
    </>
  );
}
