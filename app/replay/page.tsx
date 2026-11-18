import { redirect } from "next/navigation";

// A replay always belongs to one recorded run. Without a run ID the list of
// recorded runs is the place to pick one.
export default function ReplayIndexPage() {
  redirect("/history");
}
