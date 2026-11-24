import { configure } from "@testing-library/react";

// findBy*/waitFor default to 1 s, which slow hosted macOS runners exceed.
configure({ asyncUtilTimeout: 5_000 });
