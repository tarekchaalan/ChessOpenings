import LegacyRedirect from "@/components/legacy/LegacyRedirect";

export default async function LegacyLearnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LegacyRedirect id={Number(id)} kind="learn" />;
}
