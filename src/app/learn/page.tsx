import { redirect } from "next/navigation";

/** /learn was the v1 catalog; the catalog is /openings now. */
export default function LearnPage() {
  redirect("/openings");
}
