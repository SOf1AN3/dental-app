export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-primary">DentalCare</h1>
          <p className="mt-2 text-sm text-cool-500">
            Gestion de cabinet dentaire
          </p>
        </div>
        <div className="rounded-xl bg-white dark:bg-cool-100 px-8 py-10 shadow-sm border border-cool-100">
          {children}
        </div>
      </div>
    </div>
  );
}
