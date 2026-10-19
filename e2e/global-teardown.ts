import { restoreData } from "./fixtures";
export default async function globalTeardown() {
  await restoreData();
}
