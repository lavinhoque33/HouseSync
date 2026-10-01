# Dependency advisory review

This review records the dependency baseline's known advisories. **Passing tests do not make that baseline vulnerability-free.** The September 2026 review examined the resolved dependency graph without upgrading it or testing live deployments.

## Observed results

- `npm audit --json`: no reported advisories for the locked web graph at review time.
- [OSV batch queries](https://google.github.io/osv.dev/post-v1-querybatch/) for 152 resolved Maven compile/runtime/test coordinates returned six advisory matches: three for Tomcat 11.0.24 and three for Jackson Databind 3.1.5.
- The [upstream Apache notices](https://tomcat.apache.org/security-11.html) identified **23** Tomcat entries affecting 11.0.24 across the fixes in 11.0.25 and 11.0.26. Thus the six OSV matches were not an exhaustive advisory inventory. These are affected-component counts, not counts of demonstrated exploitable HouseSync endpoints.

## Applicability and remaining risk

Tomcat's reviewed notices concern container authentication/constraints, HTTP/2, AJP, WebSockets, TLS/client certificates, rewrite rules, Unix sockets and HTTP/1.0 handling. The application uses Spring-managed JSON login and authorization, one embedded application, no configured WebSocket/AJP endpoints, and HTTP/2 disabled by default. The [nginx backend hop](../../web/nginx.conf) explicitly uses HTTP/1.1; reference edge TLS terminates at Caddy rather than Tomcat.

**CVE-2026-77756 still affects the installed HTTP parser.** The documented proxy's HTTP/1.1 upstream avoids the described HTTP/1.0 trigger through that chain, but loopback and Compose-network callers can reach the backend directly. CSRF and controller validation are not parser patches. Different deployment/proxy settings require a new assessment; this review did not establish or attempt a live cross-user attack.

The Jackson matches require particular untrusted deserialization targets/configuration:

| Advisory | Required binding/feature | Source review |
| --- | --- | --- |
| [GHSA-gx83-3vf8-gh7j](https://github.com/FasterXML/jackson-databind/security/advisories/GHSA-gx83-3vf8-gh7j) | Polymorphic `Comparable` binding with an insufficient validator | No such binding/default typing found |
| [GHSA-q4xh-88c3-wmh7](https://github.com/FasterXML/jackson-databind/security/advisories/GHSA-q4xh-88c3-wmh7) | `javax.xml.datatype.Duration` / `XMLGregorianCalendar` strings | No such input types found; `java.time.Duration` is a different type |
| [GHSA-wjgm-6hv5-3cvf](https://github.com/FasterXML/jackson-databind/security/advisories/GHSA-wjgm-6hv5-3cvf) | Untrusted `java.nio.file.Path` binding and relevant filesystem providers | No such binding found |

These missing prerequisites narrow observed applicability; they do not certify immunity or justify suppressing dependency alerts. No exploit payloads were run against a service.

## Maintenance recommendation

Before operating an internet-facing instance, select and verify a compatible Spring Boot maintenance update or aligned dependency overrides covering **Tomcat 11.0.26 or newer** and the **Jackson 3.1.6 or newer compatible line**. Tomcat 11.0.25 alone does not cover all reviewed fixes. Keep Tomcat modules and the Jackson family aligned; no particular Boot upgrade has been selected or validated here.

Re-resolve advisories/licenses, run `make verify`, rebuild containers and repeat authenticated/privacy browser/API checks after updating. This review does not cover every Maven plugin transitive dependency, container OS package, future advisory or effective operator configuration. See [testing](testing.md) and [deployment boundaries](deployment.md).
