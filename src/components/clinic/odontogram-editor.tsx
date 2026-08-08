"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import OdontogramApp, {
  importStatus,
  onStateChange,
  exportStatusPayload,
} from "@/components/odontogram/App";
import type { OdontogramThemeConfig } from "@/components/odontogram/App";
import {
  getOdontogramState,
  saveOdontogramState,
} from "@/lib/actions/odontogram";
import "@/components/odontogram/index.css";

const themeConfig: OdontogramThemeConfig = {
  colors: {
    background: "#f7f9fb",
    panel: "#ffffff",
    card: "#ffffff",
    text: "#191c1e",
    muted: "#45464d",
    line: "#e2e8f0",
    accent: "#006591",
    accent2: "#12b981",
  },
};

export default function OdontogramEditor({
  patientId,
  initialState,
  initialVersion,
}: {
  patientId: string;
  initialState?: unknown;
  initialVersion: number;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const payloadRef = useRef<ReturnType<typeof exportStatusPayload> | null>(null);
  const versionRef = useRef(initialVersion);
  const conflictRef = useRef(false);
  const [state, setState] = useState<unknown>(initialState);
  const [, setVersion] = useState(initialVersion);
  const [conflict, setConflict] = useState(false);

  const handleConflict = useCallback((currentVersion: number) => {
    conflictRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    payloadRef.current = null;
    setVersion(currentVersion);
    setConflict(true);
  }, []);

  const performSave = useCallback(
    async (payload: unknown, expectedVersion: number) => {
      if (conflictRef.current) return;
      const result = await saveOdontogramState(
        patientId,
        payload,
        expectedVersion,
      );
      if (!result.ok) {
        if ("code" in result && result.code === "CONFLICT") {
          handleConflict(result.currentVersion);
        }
        return;
      }
      versionRef.current = result.version;
      setVersion(result.version);
    },
    [patientId, handleConflict],
  );

  const reload = useCallback(async () => {
    const fresh = await getOdontogramState(patientId);
    if (!fresh) return;
    importStatus(fresh.state);
    setState(fresh.state);
    versionRef.current = fresh.version;
    setVersion(fresh.version);
    payloadRef.current = null;
    conflictRef.current = false;
    setConflict(false);
  }, [patientId]);

  useEffect(() => {
    const off = onStateChange(() => {
      if (conflictRef.current) return;
      const payload = exportStatusPayload();
      payloadRef.current = payload;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        performSave(payload, versionRef.current).catch(() => {});
      }, 800);
    });

    return () => {
      off();
      if (timerRef.current) clearTimeout(timerRef.current);
      if (payloadRef.current != null && !conflictRef.current) {
        performSave(payloadRef.current, versionRef.current).catch(() => {});
      }
      payloadRef.current = null;
    };
  }, [performSave]);

  return (
    <div>
      {conflict && (
        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between dark:bg-amber-500/10 dark:border-amber-500/20">
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-400">
              L&apos;odontogramme a été modifié dans une autre session.
            </p>
            <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
              Vos modifications locales n&apos;ont pas été enregistrées.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              reload().catch(() => {});
            }}
            className="shrink-0 rounded-lg bg-cerulean px-3 py-1.5 text-sm font-medium text-white hover:bg-cerulean/90 transition-colors"
          >
            Recharger la version à jour
          </button>
        </div>
      )}
      <OdontogramApp initialState={state} themeConfig={themeConfig} />
    </div>
  );
}
