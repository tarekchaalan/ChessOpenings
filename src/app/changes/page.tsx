import type { Metadata } from "next";
import ChangesClient from "@/components/changes/ChangesClient";

export const metadata: Metadata = {
  title: "Opening data changes",
  description: "What changed in the opening data: new, removed and renamed lines.",
};

export default function ChangesPage() {
  return <ChangesClient />;
}
