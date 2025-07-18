const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Hello contract", function () {
  let Hello, hello;

  beforeEach(async function () {
    Hello = await ethers.getContractFactory("Hello");
    hello = await Hello.deploy("Ciao mondo!");
  });

  it("should have the initial message", async function () {
    expect(await hello.getMessage()).to.equal("Ciao mondo!");
  });

  it("should update the message", async function () {
    await hello.setMessage("Nuovo messaggio");
    expect(await hello.getMessage()).to.equal("Nuovo messaggio");
  });
});
