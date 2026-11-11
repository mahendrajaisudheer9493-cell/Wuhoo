export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-[#F8FAFC] px-4">
      <div className="mb-8 flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#4F46E5]">
          <span className="text-sm font-bold text-white">W</span>
        </div>
        <span className="text-base font-semibold text-[#17172A]">Wuhoo</span>
      </div>
      {children}
    </div>
  );
}
