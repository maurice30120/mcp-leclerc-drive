/**
 * SSRF gate — isLeclercHost / hostOf (ADR 0004 + carve-out for the store finder).
 */
import { test, assert, isLeclercHost, hostOf } from "./helpers.ts";

test("isLeclercHost: accepts fdN-courses.leclercdrive.fr only", () => {
  assert.equal(isLeclercHost("fd9-courses.leclercdrive.fr"), true);
  assert.equal(isLeclercHost("fd11-courses.leclercdrive.fr"), true);
  assert.equal(isLeclercHost("fd123-courses.leclercdrive.fr"), true);
});

test("isLeclercHost: rejects look-alikes and arbitrary hosts (SSRF gate)", () => {
  assert.equal(isLeclercHost("evil.com"), false);
  assert.equal(isLeclercHost("fd9-courses.leclercdrive.evil.com"), false);
  assert.equal(isLeclercHost("leclercdrive.fr"), false);
  assert.equal(isLeclercHost("courses.leclercdrive.fr"), false); // missing fdN-
  assert.equal(isLeclercHost("xfd9-courses.leclercdrive.fr"), false);
  assert.equal(isLeclercHost("FD9-courses.leclercdrive.fr"), true); // case-insensitive
  assert.equal(isLeclercHost(""), false);
});

test("hostOf: extracts host, returns '' for missing/garbage", () => {
  assert.equal(hostOf("https://fd9-courses.leclercdrive.fr/path"), "fd9-courses.leclercdrive.fr");
  assert.equal(hostOf(undefined), "");
  assert.equal(hostOf(""), "");
  assert.equal(hostOf("not a url"), "");
});