# Third-party notices

HouseSync's first-party source is licensed under [MIT](LICENSE). That license does not replace the licenses of third-party software used by the build or application.

## Redistributed Maven Wrapper scripts

`backend/mvnw` and `backend/mvnw.cmd` retain their upstream Apache headers. The wrapper is Apache Maven Wrapper 3.3.4, licensed under the [Apache License, Version 2.0](LICENSES/Apache-2.0.txt). Its [upstream NOTICE](LICENSES/Maven-Wrapper-NOTICE.txt) is included without removing the Apache Software Foundation or original Gradle Wrapper attribution.

Sources: [Apache license](https://www.apache.org/licenses/LICENSE-2.0.txt), [Maven Wrapper 3.3.4 NOTICE](https://github.com/apache/maven-wrapper/blob/maven-wrapper-3.3.4/NOTICE).

## Downloaded dependencies

The build resolves third-party packages from the backend POM, Maven Wrapper configuration and locked web manifest. The [dependency license inventory](docs/development/dependency-licenses.md) records upstream license metadata for 152 resolved Maven compile/runtime/test coordinates and 260 locked npm entries, including optional platform packages. The metadata is a review aid, not a statement that every dependency uses MIT or that every license obligation has been independently legally evaluated.

Dependency caches, `node_modules`, application JARs, container images and built web bundles are not included in this repository. If redistributing compiled applications or images, preserve the applicable dependency licenses/notices and review the assembled artifact separately. The inventory does not certify build-plugin transitives, base-image packages, fonts supplied by a user's system, or optional external services.

## Images

The screenshots under `docs/images/` were captured from this application using synthetic local data and Plaid's Sandbox test bank. They do not contain real household records or third-party stock imagery. `plaid-link-desktop.png` shows Plaid Link, Plaid's own interface, including the Plaid logo and institution logos it displays; those marks belong to their respective owners and are shown only to illustrate the integration.
