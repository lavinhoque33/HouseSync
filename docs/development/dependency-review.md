# Dependency advisory review

This review records the advisory status of the resolved dependency baseline. **Passing tests do not make that baseline vulnerability-free.** The October 2026 review re-resolved the backend and web graphs after the patched-version pins below; it did not test live deployments.

## Pinned versions

Spring Boot 4.1.1 manages Tomcat 11.0.24 and the Jackson 3 BOM at 3.1.5, both with published advisories. `backend/pom.xml` overrides the managed versions through the Boot-defined properties:

| Property | Pinned | Boot 4.1.1 default | Why |
| --- | --- | --- | --- |
| `tomcat.version` | 11.0.26 | 11.0.24 | Tomcat 11.0.25 alone does not cover every reviewed fix; 11.0.26 is the first release that does. |
| `jackson-bom.version` | 3.1.7 | 3.1.5 | 3.1.6 fixes three databind advisories; two further databind advisories are fixed only in 3.1.7. |

Property overrides keep every Tomcat module and the whole `tools.jackson` family aligned through Boot's own dependency management, instead of pinning individual artifacts. Remove each override once a Spring Boot release manages Tomcat 11.0.26 or newer and Jackson 3.1.7 or newer, respectively; an override left in place would then hold the dependency back.

## Observed results

- `sh backend/mvnw -f backend/pom.xml dependency:list` resolved **152** compile/runtime/test coordinates, including `tomcat-embed-core`, `tomcat-embed-el` and `tomcat-embed-websocket` 11.0.26 and `jackson-core`/`jackson-databind` 3.1.7.
- An [OSV batch query](https://google.github.io/osv.dev/post-v1-querybatch/) over all 152 coordinates returned **no advisory matches**. The same query for the previous Tomcat 11.0.24 and Jackson Databind 3.1.5 still returns three and five matches respectively, so the empty result reflects the pinned versions rather than a failed query.
- The [Apache Tomcat 11 security notices](https://tomcat.apache.org/security-11.html) list no fix release newer than 11.0.26 at review time.
- `npm audit` for the locked web graph (260 packages) reported no vulnerabilities. An OSV batch query over the same 260 locked package versions returned no matches.
- `make backend-check` (formatting, unit tests, packaging and PostgreSQL integration tests) passed on the pinned versions.

## Previously reported advisories

| Component | Advisory | Fixed in | Status |
| --- | --- | --- | --- |
| Apache Tomcat | 23 Apache notices affecting 11.0.24, including CVE-2026-77756 (HTTP/1.0 request parsing) | 11.0.25 / 11.0.26 | Addressed by the 11.0.26 pin |
| Jackson Databind | [GHSA-gx83-3vf8-gh7j](https://github.com/FasterXML/jackson-databind/security/advisories/GHSA-gx83-3vf8-gh7j), [GHSA-q4xh-88c3-wmh7](https://github.com/FasterXML/jackson-databind/security/advisories/GHSA-q4xh-88c3-wmh7), [GHSA-wjgm-6hv5-3cvf](https://github.com/FasterXML/jackson-databind/security/advisories/GHSA-wjgm-6hv5-3cvf) | 3.1.6 | Addressed by the 3.1.7 pin |
| Jackson Databind | [GHSA-cxp5-3px4-pw24](https://github.com/advisories/GHSA-cxp5-3px4-pw24), [GHSA-wv8q-qhhj-9h54](https://github.com/advisories/GHSA-wv8q-qhhj-9h54) | 3.1.7 | Addressed by the 3.1.7 pin |
| `brace-expansion` (web, development only) | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | 5.0.12 | Lockfile at 5.0.12 |
| `source-map-js` (web, development only) | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | 1.2.2 | Lockfile at 1.2.2 |

Source review had already found none of the specific untrusted Jackson binding targets the first three databind advisories require, and the nginx hop uses HTTP/1.1 to the backend; those narrowed applicability but were never a substitute for the patched versions.

## Scope and maintenance

This review covers the resolved backend compile/runtime/test graph and the locked web graph. It does not cover Maven build-plugin dependencies, container base-image or operating-system packages, advisories published after the review, or an operator's effective deployment configuration. An empty advisory result is point-in-time evidence, not a guarantee.

After any dependency change, re-resolve advisories and [license metadata](dependency-licenses.md), run `make verify`, rebuild containers and repeat authenticated/privacy browser/API checks. See [testing](testing.md) and [deployment boundaries](deployment.md).
