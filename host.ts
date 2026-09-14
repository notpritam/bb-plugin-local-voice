import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { defineRpcContract } from "@get-bb/plugin-sdk";

export default experimental_defineHostEntry({
  contract: defineRpcContract({}),
  handlers: {},
});
