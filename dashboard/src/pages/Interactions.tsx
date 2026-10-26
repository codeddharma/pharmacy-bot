import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Card, EmptyState, PageHeader, Skeleton, Table, Td, Th } from "@/components/ui/layout";
import { api, del, patch, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { InteractionRule } from "@/lib/types";

/**
 * Pharmacist-maintained warnings for medicines that shouldn't be taken together.
 * The bot always warns about the same ingredient twice; these rules add specific pairs.
 */
export function InteractionsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["interactions"], queryFn: () => api<{ rules: InteractionRule[] }>("/interactions") });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ ingredientA: "", ingredientB: "", message: "", severity: "warn" as "warn" | "block" });

  const refresh = () => void qc.invalidateQueries({ queryKey: ["interactions"] });
  const create = useMutation({
    mutationFn: () => post("/interactions", f),
    onSuccess: () => {
      toast.success("Rule added. The bot uses it straight away.");
      setOpen(false);
      setF({ ingredientA: "", ingredientB: "", message: "", severity: "warn" });
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggle = useMutation({ mutationFn: (r: InteractionRule) => patch(`/interactions/${r.id}`, { active: !r.active }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: number) => del(`/interactions/${id}`), onSuccess: refresh });

  return (
    <>
      <PageHeader
        title="Interaction rules"
        description="Warnings shown in the customer's cart when two medicines shouldn't be combined. Only a pharmacist should add or change these."
        actions={can("inventory.manage") ? <Button onClick={() => setOpen(true)}><Plus /> Add rule</Button> : null}
      />
      <Card className="mb-4 p-4 text-sm text-muted">
        Always on, without a rule: if two items in a cart contain the same ingredient (for example two paracetamol products), the customer is warned not to take them together.
      </Card>
      <Card>
        {rules.isLoading ? (
          <Skeleton className="m-4 h-24" />
        ) : rules.data?.rules.length === 0 ? (
          <EmptyState icon={<BookOpen />} title="No rules yet" description="Add pairs of ingredients your pharmacist wants customers warned about." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Ingredients</Th>
                <Th>Message to the customer</Th>
                <Th>Effect</Th>
                <Th>On</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rules.data?.rules.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">
                    {r.ingredientA} + {r.ingredientB}
                  </Td>
                  <Td className="max-w-md text-muted">{r.message}</Td>
                  <Td>{r.severity === "block" ? <Badge tone="red">Stops the order</Badge> : <Badge tone="amber">Warning</Badge>}</Td>
                  <Td>
                    <Switch checked={r.active} disabled={!can("inventory.manage")} onCheckedChange={() => toggle.mutate(r)} label={`Rule ${r.id} on`} />
                  </Td>
                  <Td>
                    {can("inventory.manage") ? (
                      <button type="button" onClick={() => remove.mutate(r.id)} className="text-muted hover:text-danger" aria-label="Delete rule">
                        <Trash2 className="size-4" />
                      </button>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add an interaction rule"
        description="Ingredient names are matched against each medicine's composition, ignoring case."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={create.isPending} disabled={f.ingredientA.length < 2 || f.ingredientB.length < 2 || f.message.length < 5} onClick={() => create.mutate()}>
              Add rule
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First ingredient">
            <Input value={f.ingredientA} onChange={(e) => setF({ ...f, ingredientA: e.target.value })} />
          </Field>
          <Field label="Second ingredient">
            <Input value={f.ingredientB} onChange={(e) => setF({ ...f, ingredientB: e.target.value })} />
          </Field>
          <Field label="Message shown to the customer" className="sm:col-span-2">
            <Textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} />
          </Field>
          <Field label="Effect" className="sm:col-span-2">
            <Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value as "warn" | "block" })}>
              <option value="warn">Warn, but allow the order</option>
              <option value="block">Stop the order and offer the pharmacist</option>
            </Select>
          </Field>
        </div>
      </Dialog>
    </>
  );
}
