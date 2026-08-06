"use client";

import { useActionState, useState, useEffect, useRef } from "react";
import { updateClinicTemplate } from "@/lib/actions/settings";
import {
  A5Prescription,
  type A5Template,
  type A5Data,
} from "@/components/clinic/a5-prescription";
import {
  A5_SHEET_WIDTH_PX,
  A5_SHEET_HEIGHT_PX,
} from "@/components/clinic/a5-styles";

export interface A5TemplateSettingsProps {
  defaultValues: {
    name: string;
    address: string | null;
    phone: string | null;
    email: string | null;
    legalInfo: string | null;
    logoUrl: string | null;
    headerUrl: string | null;
    watermarkEnabled: boolean;
  };
}

export function A5TemplateSettings({
  defaultValues,
}: A5TemplateSettingsProps) {
  const [state, action, pending] = useActionState(updateClinicTemplate, undefined);
  const [watermark, setWatermark] = useState(defaultValues.watermarkEnabled);

  const previewRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const generalError =
    state && "error" in state && state.error && "general" in state.error
      ? (state.error as Record<string, string[] | undefined>).general?.[0]
      : undefined;

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scale =
    containerWidth > 0 ? Math.min(1, containerWidth / A5_SHEET_WIDTH_PX) : 1;

  const template: A5Template = {
    name: defaultValues.name,
    address: defaultValues.address,
    phone: defaultValues.phone,
    email: defaultValues.email,
    legalInfo: defaultValues.legalInfo,
    logoUrl: defaultValues.logoUrl,
    headerUrl: defaultValues.headerUrl,
    watermarkEnabled: watermark,
  };

  const previewData: A5Data = {
    rxNumber: "DEMO-001",
    patientName: "Test Patient",
    patientBirthdate: "01/01/1990",
    dentistName: "Dr. Test",
    date: "01/01/2026",
    notes: "Exemple de note d'ordonnance.",
    items: [
      {
        type: "medication",
        name: "Paracétamol 500mg",
        dosage: "500 mg",
        form: "Comprimé",
        frequency: "3x/jour",
        duration: "5 jours",
        quantity: 15,
        instructions: "À prendre au moment des repas.",
      },
    ],
  };

  return (
    <form action={action} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            name="watermarkEnabled"
            checked={watermark}
            onChange={(e) => setWatermark(e.target.checked)}
            className="h-4 w-4 rounded border-cool-300 text-cerulean focus:ring-cerulean"
          />
          <span className="text-sm font-medium text-cool-700">
            Afficher le logo en filigrane sur l&apos;ordonnance
          </span>
        </label>

        {generalError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {generalError}
          </div>
        )}

        {state?.success && (
          <p className="text-sm text-green-600">
            Modèle d&apos;ordonnance mis à jour.
          </p>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
          >
            {pending ? "Enregistrement..." : "Enregistrer"}
          </button>
        </div>
      </div>

      <div className="hidden lg:block">
        <p className="mb-2 text-xs font-medium text-cool-500 uppercase tracking-wider">
          Aperçu A5
        </p>
        <div ref={previewRef} className="w-full">
          <div
            className="overflow-hidden rounded-lg border border-cool-200 shadow-lg"
            style={{
              width: A5_SHEET_WIDTH_PX * scale,
              height: A5_SHEET_HEIGHT_PX * scale,
            }}
          >
            <div
              style={{
                transform: `scale(${scale})`,
                transformOrigin: "top left",
                width: "148mm",
                height: "210mm",
              }}
            >
              <A5Prescription template={template} data={previewData} />
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
