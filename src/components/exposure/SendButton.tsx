"use client";

import { useFormStatus } from "react-dom";

/** Submit button that shows it is working and cannot be pressed twice. */
export function SendButton({ children, pending: pendingText }: { children: React.ReactNode; pending: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary self-start min-h-11" disabled={pending} aria-busy={pending}>
      {pending ? pendingText : children}
    </button>
  );
}
