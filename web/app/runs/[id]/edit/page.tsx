import ControlPanel from "@/components/control-panel";

export default async function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ControlPanel editCampaignId={id} />;
}
