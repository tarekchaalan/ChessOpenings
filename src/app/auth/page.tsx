import { Suspense } from "react";
import type { Metadata } from "next";
import AuthClient from "@/components/auth/AuthClient";

export const metadata: Metadata = { title: "Sign in" };

export default function AuthPage() {
  return (
    <Suspense>
      <AuthClient />
    </Suspense>
  );
}
