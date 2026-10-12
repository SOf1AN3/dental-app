import { PageHeader } from "@/components/ui/page-header";
import { SettingsTabs } from "./settings-tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <PageHeader
        title="Paramètres"
        description="Gérez votre clinique, vos membres et votre abonnement."
      />

      <SettingsTabs />

      {children}
    </div>
  );
}
