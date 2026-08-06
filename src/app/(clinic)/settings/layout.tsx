import { SettingsTabs } from "./settings-tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900 dark:text-cool-900">Paramètres</h1>
        <p className="text-sm text-cool-500">Gérez votre clinique, vos membres et votre abonnement.</p>
      </div>

      <SettingsTabs />

      {children}
    </div>
  );
}
