import HubClient from "@/components/openings/HubClient";

export default async function HubPage({ params }: { params: Promise<{ hub: string }> }) {
  const { hub } = await params;
  return <HubClient slug={hub} />;
}
