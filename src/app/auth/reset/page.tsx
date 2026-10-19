import type { Metadata } from "next";
import ResetPasswordClient from "@/components/auth/ResetPasswordClient";

export const metadata: Metadata = { title: "Choose a new password" };

export default function ResetPasswordPage() {
  return <ResetPasswordClient />;
}
