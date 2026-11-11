interface EmptyStateProps {
  children?: React.ReactNode;
  title: string;
  description: string;
}

export function EmptyState({ children, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      {children && (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#F5F3FF] text-[#4F46E5]">
          {children}
        </div>
      )}
      <p className="text-sm font-medium text-[#17172A]">{title}</p>
      <p className="max-w-xs text-xs text-[#64748B]">{description}</p>
    </div>
  );
}
