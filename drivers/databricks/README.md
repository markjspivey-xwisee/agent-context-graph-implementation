# Databricks ODBC Driver (Local Install)

Download the Databricks **ODBC driver for Linux** (Simba Spark ODBC) from the Databricks
documentation and place the installer here (`.deb` or `.rpm`).

Suggested file location:

```
drivers/databricks/<databricks-odbc-driver>.deb
```

or

```
drivers/databricks/<databricks-odbc-driver>.rpm
```

Notes:
- This repo does **not** commit driver binaries.
- The installer is required by the Virtuoso container to connect to Databricks via ODBC.
- See Databricks' driver install guide for the correct package for your platform.
