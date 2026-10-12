"use client";

import { useEffect, useMemo, useState } from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import {
  createSessionItem,
  updateSessionItem,
  deleteSessionItem,
} from "@/lib/actions/session";
import { TreatmentCatalogCombobox } from "@/components/clinic/treatment-catalog-combobox";
import {
  getActiveCatalogOptions,
  type CatalogItem,
} from "@/lib/treatment-catalog-utils";
import { formatCurrency } from "@/lib/utils";

export interface SessionItem {
  id: string;
  toothNumber: number | null;
  surface: string | null;
  procedureCode: string | null;
  description: string;
  fee: number;
  quantity: number;
  discount: number | null;
  taxRate: number | null;
}

interface SessionTreatmentsProps {
  sessionId: string;
  initialItems: SessionItem[];
  catalog: CatalogItem[];
  disabled?: boolean;
}

type FieldErrorState = { error?: Record<string, string[]> } | { success: true };

const cellInputClassName =
  "block w-full rounded-lg border border-input bg-transparent px-2 py-1.5 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none";

const labelClassName = "block text-[11px] font-medium text-muted-fg";

// Shared responsive grid (10 columns on xl: Dent, Face, Code, Description(2),
// Honoraire, Qté, Remise, TVA, Actions). Header and rows use the same classes
// so they stay aligned.
const rowGridClassName =
  "grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 xl:grid-cols-10 xl:items-end";

function extractFieldErrors(state: FieldErrorState | undefined) {
  return state && "error" in state && state.error && !("general" in state.error)
    ? (state.error as Record<string, string[] | undefined>)
    : ({} as Record<string, string[] | undefined>);
}

function extractGeneralError(state: FieldErrorState | undefined) {
  return state && "error" in state && state.error && "general" in state.error
    ? (state.error as Record<string, string[] | undefined>).general?.[0]
    : undefined;
}

function SessionItemRow({
  item,
  catalog,
}: {
  item: SessionItem;
  catalog: CatalogItem[];
}) {
  const router = useRouter();
  const [description, setDescription] = useState(item.description);
  const [procedureCode, setProcedureCode] = useState(item.procedureCode ?? "");
  const [fee, setFee] = useState(item.fee);

  const activeOptions = useMemo(() => getActiveCatalogOptions(catalog), [catalog]);

  const [state, formAction, pending] = useActionState(
    updateSessionItem.bind(null, item.id),
    undefined,
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteSessionItem.bind(null, item.id),
    undefined,
  );

  useEffect(() => {
    if (state && "success" in state && state.success) router.refresh();
  }, [state, router]);

  useEffect(() => {
    if (deleteState && "success" in deleteState && deleteState.success) {
      router.refresh();
    }
  }, [deleteState, router]);

  const fieldErrors = extractFieldErrors(state);
  const generalError = extractGeneralError(state);
  const deleteError = deleteState && "error" in deleteState ? deleteState.error : undefined;

  return (
    <div className="border-b border-border px-3 py-3">
      <form action={formAction} className={rowGridClassName}>
        <div>
          <label className={labelClassName}>Dent</label>
          <input
            type="number"
            min={1}
            max={48}
            inputMode="numeric"
            name="toothNumber"
            defaultValue={item.toothNumber ?? ""}
            className={cellInputClassName}
          />
          {fieldErrors?.toothNumber && (
            <p className="mt-0.5 text-xs text-destructive">{fieldErrors.toothNumber[0]}</p>
          )}
        </div>
        <div>
          <label className={labelClassName}>Face</label>
          <input
            type="text"
            name="surface"
            defaultValue={item.surface ?? ""}
            className={cellInputClassName}
          />
          {fieldErrors?.surface && (
            <p className="mt-0.5 text-xs text-destructive">{fieldErrors.surface[0]}</p>
          )}
        </div>
        <div>
          <label className={labelClassName}>Code</label>
          <input
            type="text"
            name="procedureCode"
            value={procedureCode}
            onChange={(e) => setProcedureCode(e.target.value)}
            className={cellInputClassName}
          />
          {fieldErrors?.procedureCode && (
            <p className="mt-0.5 text-xs text-destructive">{fieldErrors.procedureCode[0]}</p>
          )}
        </div>
        <div className="xl:col-span-2">
          <label className={labelClassName}>Description</label>
          <TreatmentCatalogCombobox
            options={activeOptions}
            value={description}
            onValueChange={setDescription}
            onSelectOption={(opt) => {
              setDescription(opt.name);
              setProcedureCode(opt.code ?? "");
              setFee(opt.price);
            }}
            name="description"
            className={cellInputClassName}
          />
          {fieldErrors?.description && (
            <p className="mt-0.5 text-xs text-destructive">{fieldErrors.description[0]}</p>
          )}
        </div>
        <div>
          <label className={labelClassName}>Honoraire (DZD)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            inputMode="numeric"
            name="fee"
            value={fee}
            onChange={(e) => setFee(e.target.value === "" ? 0 : Number(e.target.value))}
            className={cellInputClassName}
          />
          {fieldErrors?.fee && (
            <p className="mt-0.5 text-xs text-destructive">{fieldErrors.fee[0]}</p>
          )}
        </div>
        <div>
          <label className={labelClassName}>Qté</label>
          <input
            type="number"
            min={1}
            step="1"
            inputMode="numeric"
            name="quantity"
            defaultValue={item.quantity}
            className={cellInputClassName}
          />
          {fieldErrors?.quantity && (
            <p className="mt-0.5 text-xs text-destructive">{fieldErrors.quantity[0]}</p>
          )}
        </div>
        <div>
          <label className={labelClassName}>Remise (DZD)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            inputMode="numeric"
            name="discount"
            defaultValue={item.discount ?? 0}
            className={cellInputClassName}
          />
          {fieldErrors?.discount && (
            <p className="mt-0.5 text-xs text-destructive">{fieldErrors.discount[0]}</p>
          )}
        </div>
        <div>
          <label className={labelClassName}>TVA (%)</label>
          <input
            type="number"
            min={0}
            step="1"
            inputMode="numeric"
            name="taxRate"
            defaultValue={item.taxRate ?? 0}
            className={cellInputClassName}
          />
          {fieldErrors?.taxRate && (
            <p className="mt-0.5 text-xs text-destructive">{fieldErrors.taxRate[0]}</p>
          )}
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            {pending ? "Enregistrement..." : "Enregistrer"}
          </button>
        </div>
      </form>

      <div className="mt-2 flex items-center justify-between gap-3">
        {generalError && <p className="text-xs text-destructive">{generalError}</p>}
        <form action={deleteAction} className="ml-auto">
          <button
            type="submit"
            disabled={deletePending}
            className="text-xs font-medium text-destructive hover:text-destructive/80 disabled:opacity-50 transition-colors"
          >
            {deletePending ? "Suppression..." : "Supprimer"}
          </button>
        </form>
      </div>
      {deleteError && <p className="mt-1 text-xs text-destructive">{deleteError}</p>}
    </div>
  );
}

function AddSessionItemForm({
  sessionId,
  catalog,
}: {
  sessionId: string;
  catalog: CatalogItem[];
}) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [procedureCode, setProcedureCode] = useState("");
  const [fee, setFee] = useState(0);

  const activeOptions = useMemo(() => getActiveCatalogOptions(catalog), [catalog]);

  const [state, formAction, pending] = useActionState(
    createSessionItem.bind(null, sessionId),
    undefined,
  );

  useEffect(() => {
    if (state && "success" in state && state.success) router.refresh();
  }, [state, router]);

  const fieldErrors = extractFieldErrors(state);
  const generalError = extractGeneralError(state);

  return (
    <div className="border-t border-border-card bg-muted/50 px-3 py-4">
      <form action={formAction} className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">Ajouter un acte</h3>
          {generalError && <p className="text-xs text-destructive">{generalError}</p>}
        </div>

        <div className={rowGridClassName}>
          <div>
            <label className={labelClassName}>Dent</label>
            <input
              type="number"
              min={1}
              max={48}
              inputMode="numeric"
              name="toothNumber"
              className={cellInputClassName}
            />
            {fieldErrors?.toothNumber && (
              <p className="mt-0.5 text-xs text-destructive">{fieldErrors.toothNumber[0]}</p>
            )}
          </div>
          <div>
            <label className={labelClassName}>Face</label>
            <input type="text" name="surface" className={cellInputClassName} />
            {fieldErrors?.surface && (
              <p className="mt-0.5 text-xs text-destructive">{fieldErrors.surface[0]}</p>
            )}
          </div>
          <div>
            <label className={labelClassName}>Code</label>
            <input
              type="text"
              name="procedureCode"
              value={procedureCode}
              onChange={(e) => setProcedureCode(e.target.value)}
              className={cellInputClassName}
            />
            {fieldErrors?.procedureCode && (
              <p className="mt-0.5 text-xs text-destructive">{fieldErrors.procedureCode[0]}</p>
            )}
          </div>
          <div className="xl:col-span-2">
            <label className={labelClassName}>Description</label>
            <TreatmentCatalogCombobox
              options={activeOptions}
              value={description}
              onValueChange={setDescription}
              onSelectOption={(opt) => {
                setDescription(opt.name);
                setProcedureCode(opt.code ?? "");
                setFee(opt.price);
              }}
              placeholder="Sélectionner dans le catalogue..."
              name="description"
              className={cellInputClassName}
            />
            {fieldErrors?.description && (
              <p className="mt-0.5 text-xs text-destructive">{fieldErrors.description[0]}</p>
            )}
          </div>
          <div>
            <label className={labelClassName}>Honoraire (DZD)</label>
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="numeric"
              name="fee"
              value={fee === 0 ? "" : fee}
              onChange={(e) => setFee(Number(e.target.value))}
              placeholder="0.00"
              className={cellInputClassName}
            />
            {fieldErrors?.fee && (
              <p className="mt-0.5 text-xs text-destructive">{fieldErrors.fee[0]}</p>
            )}
          </div>
          <div>
            <label className={labelClassName}>Qté</label>
            <input
              type="number"
              min={1}
              step="1"
              inputMode="numeric"
              name="quantity"
              defaultValue={1}
              className={cellInputClassName}
            />
            {fieldErrors?.quantity && (
              <p className="mt-0.5 text-xs text-destructive">{fieldErrors.quantity[0]}</p>
            )}
          </div>
          <div>
            <label className={labelClassName}>Remise (DZD)</label>
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="numeric"
              name="discount"
              defaultValue={0}
              className={cellInputClassName}
            />
            {fieldErrors?.discount && (
              <p className="mt-0.5 text-xs text-destructive">{fieldErrors.discount[0]}</p>
            )}
          </div>
          <div>
            <label className={labelClassName}>TVA (%)</label>
            <input
              type="number"
              min={0}
              step="1"
              inputMode="numeric"
              name="taxRate"
              defaultValue={0}
              className={cellInputClassName}
            />
            {fieldErrors?.taxRate && (
              <p className="mt-0.5 text-xs text-destructive">{fieldErrors.taxRate[0]}</p>
            )}
          </div>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
            >
              {pending ? "Ajout..." : "Ajouter"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function itemTotal(item: SessionItem): number {
  return item.fee * item.quantity - (item.discount ?? 0);
}

function ReadOnlyItemsTable({
  items,
  total,
}: {
  items: SessionItem[];
  total: number;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border-card bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-card bg-muted">
            <th className="px-4 py-3 text-left text-xs font-medium text-muted-fg uppercase tracking-wider">Dent</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-muted-fg uppercase tracking-wider">Face</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-muted-fg uppercase tracking-wider">Code</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-muted-fg uppercase tracking-wider">Description</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-muted-fg uppercase tracking-wider">Honoraire</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-muted-fg uppercase tracking-wider">Qté</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-muted-fg uppercase tracking-wider">Remise</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-muted-fg uppercase tracking-wider">Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              className="border-b border-border hover:bg-muted transition-colors"
            >
              <td className="px-4 py-3 text-muted-fg">{item.toothNumber ?? "-"}</td>
              <td className="px-4 py-3 text-muted-fg">{item.surface ?? "-"}</td>
              <td className="px-4 py-3 text-muted-fg">{item.procedureCode ?? "-"}</td>
              <td className="px-4 py-3 text-foreground">{item.description}</td>
              <td className="px-4 py-3 text-right text-muted-fg">{formatCurrency(item.fee)}</td>
              <td className="px-4 py-3 text-right text-muted-fg">{item.quantity}</td>
              <td className="px-4 py-3 text-right text-muted-fg">
                {(item.discount ?? 0) > 0 ? formatCurrency(item.discount ?? 0) : "-"}
              </td>
              <td className="px-4 py-3 text-right font-medium text-foreground">
                {formatCurrency(itemTotal(item))}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border-card bg-muted/50">
            <td colSpan={7} className="px-4 py-3 text-right text-sm font-medium text-muted-fg">
              Total
            </td>
            <td className="px-4 py-3 text-right text-base font-semibold text-foreground">
              {formatCurrency(total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function EditableItemsTable({
  items,
  catalog,
}: {
  items: SessionItem[];
  catalog: CatalogItem[];
}) {
  const total = items.reduce((acc, item) => acc + itemTotal(item), 0);

  return (
    <div className="overflow-x-auto rounded-xl border border-border-card bg-card">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-border-card bg-muted px-3 py-2 text-xs font-medium text-muted-fg uppercase tracking-wider sm:grid-cols-3 xl:grid-cols-10">
        <span>Dent</span>
        <span>Face</span>
        <span>Code</span>
        <span className="xl:col-span-2">Description</span>
        <span>Honoraire</span>
        <span>Qté</span>
        <span>Remise</span>
        <span>TVA</span>
        <span className="sr-only">Actions</span>
      </div>
      {items.map((item) => (
        <SessionItemRow key={item.id} item={item} catalog={catalog} />
      ))}
      <div className="flex items-center justify-end gap-3 px-3 py-3">
        <span className="text-sm font-medium text-muted-fg">Total</span>
        <span className="text-base font-semibold text-foreground">
          {formatCurrency(total)}
        </span>
      </div>
    </div>
  );
}

export function SessionTreatments({
  sessionId,
  initialItems,
  catalog,
  disabled = false,
}: SessionTreatmentsProps) {
  const total = initialItems.reduce((acc, item) => acc + itemTotal(item), 0);

  return (
    <div className="space-y-4">
      {initialItems.length === 0 ? (
        <div className="rounded-xl border border-border-card bg-card p-10 text-center">
          <p className="text-sm text-muted-fg">Aucun acte ajouté à cette séance</p>
        </div>
      ) : disabled ? (
        <ReadOnlyItemsTable items={initialItems} total={total} />
      ) : (
        <EditableItemsTable items={initialItems} catalog={catalog} />
      )}

      {!disabled && <AddSessionItemForm sessionId={sessionId} catalog={catalog} />}
    </div>
  );
}
