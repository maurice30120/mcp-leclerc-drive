/**
 * Store-finder payload sanity — exercises the NearbyResponse/Autocomplete/
 * Coordinates types alongside the SSRF + host helpers they flow through.
 */
import { test, assert, hostOf, isLeclercHost, type NearbyResponse } from "./helpers.ts";

test("NearbyResponse type is exercised by a sample payload", () => {
  const near: NearbyResponse = {
    points: [
      { noPL: "1", name: "Drive", serviceType: "drive", urlSiteCourse: "https://fd9-courses.leclercdrive.fr/" },
    ],
  };
  assert.equal(near.points?.length, 1);
  assert.equal(hostOf(near.points[0].urlSiteCourse), "fd9-courses.leclercdrive.fr");
  assert.ok(isLeclercHost(hostOf(near.points[0].urlSiteCourse ?? "")));
});