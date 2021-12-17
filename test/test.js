const { expect } = require("chai");
const { time } = require("@openzeppelin/test-helpers");

describe("SHO smart contract", function() {
    let owner, feeCollector, user1, user2, user3, contract, shoToken, shoTokenDecimals;

    const PRECISION_LOSS = "10000000000000000";
    
    const parseUnits = (value, decimals = shoTokenDecimals) => {
        return ethers.utils.parseUnits(value.toString(), decimals);
    }

    const whitelistUsers = async(whitelist) => {
        const allocations = whitelist.allocations.map((raw) => parseUnits(raw));

        await expect(contract.whitelistUsers([owner.address], [1, 1], [0, 0])).to.be.revertedWith("SHO: different array lengths");
        await expect(contract.whitelistUsers([], [], [])).to.be.revertedWith("SHO: zero length array");
        await expect(contract.whitelistUsers([owner.address], [1], [2])).to.be.revertedWith("SHO: invalid user option");

        contract = contract.connect(user1); 
        await expect(contract.whitelistUsers(whitelist.wallets, allocations, whitelist.options))
            .to.be.revertedWith("Ownable: caller is not the owner");

        contract = contract.connect(owner); 
        await contract.whitelistUsers(whitelist.wallets, allocations, whitelist.options);
        await expect(contract.whitelistUsers(whitelist.wallets, allocations, whitelist.options))
            .to.be.revertedWith("SHO: some users are already whitelisted");

        for (let i = 0; i < whitelist.wallets.length; i++) {
            const userInfo = await contract.users(whitelist.wallets[i]);
            expect(userInfo.allocation).to.equal(allocations[i]);
        }
        
        const globalTotalAllocation = whitelist.allocations.reduce((p, c) => p + c);
        await shoToken.transfer(contract.address, parseUnits(globalTotalAllocation));
        await expect(contract.whitelistUsers([owner.address], [1], [0]))
            .to.be.revertedWith("SHO: whitelisting too late");

        expect(await contract.globalTotalAllocation()).to.equal(parseUnits(globalTotalAllocation));
    }

    const testConstructorRequireStatements = async(unlockPercentages, unlockPeriods, initialFee, startTime) => {
        const Contract = await ethers.getContractFactory("SHO");

        await expect(Contract.deploy(ethers.constants.AddressZero, unlockPercentages, unlockPeriods, initialFee, feeCollector.address, startTime))
            .to.be.revertedWith("SHO: sho token zero address");

        await expect(Contract.deploy(shoToken.address, [], unlockPeriods, initialFee, feeCollector.address, startTime))
            .to.be.revertedWith("SHO: 0 unlock percentages");

        const unlockPercentagesMany = new Array(201).fill(0);
        await expect(Contract.deploy(shoToken.address, unlockPercentagesMany, unlockPeriods, initialFee, feeCollector.address, startTime))
            .to.be.revertedWith("SHO: too many unlock percentages");  

        await expect(Contract.deploy(shoToken.address, unlockPercentages, unlockPeriods.concat(1000), initialFee, feeCollector.address, startTime))
            .to.be.revertedWith("SHO: different array lengths"); 
            
        await expect(Contract.deploy(shoToken.address, unlockPercentages, unlockPeriods, 1e6 + 1, feeCollector.address, startTime))
            .to.be.revertedWith("SHO: initial fee percentage higher than 100%"); 
        
        await expect(Contract.deploy(shoToken.address, unlockPercentages, unlockPeriods, initialFee, ethers.constants.AddressZero, startTime))
            .to.be.revertedWith("SHO: fee collector zero address"); 

        await expect(Contract.deploy(shoToken.address, unlockPercentages, unlockPeriods, initialFee, feeCollector.address, 10000000))
            .to.be.revertedWith("SHO: start time must be in future"); 
    }

    const init = async(unlockPercentages, unlockPeriods, initialFee, whitelist, shoTokenDecimals = 18) => {
        const startTime = Number(await time.latest()) + 300;
        const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
        shoToken = await ERC20Mock.deploy("MOCK1", "MOCK1", owner.address, parseUnits(100000000), shoTokenDecimals);

        await testConstructorRequireStatements(unlockPercentages, unlockPeriods, initialFee, startTime);

        const Contract = await ethers.getContractFactory("SHO");
        contract = await Contract.deploy(
            shoToken.address,
            unlockPercentages,
            unlockPeriods,
            initialFee,
            feeCollector.address,
            startTime
        );

        expect(await contract.shoToken()).to.equal(shoToken.address);
        expect(await contract.startTime()).to.equal(startTime);
        expect(await contract.feeCollector()).to.equal(feeCollector.address);
        expect(await contract.initialFeePercentage()).to.equal(initialFee);
        expect(await contract.passedUnlocksCount()).to.equal(0);

        await whitelistUsers(whitelist);

        await expect(contract.update()).to.be.revertedWith("SHO: before startTime");

        contract = contract.connect(feeCollector);
        await expect(contract.collectFees()).to.be.revertedWith("SHO: before startTime");

        contract = contract.connect(user1);
        await expect(contract.claim(0)).to.be.revertedWith("SHO: before startTime");

        await time.increaseTo(startTime);
    }

    const collectFees = async(collectedAll, expectedBaseFee, expectedExtraFee) => {
        contract = contract.connect(feeCollector);
        if (collectedAll) {
            await expect(contract.collectFees()).to.be.revertedWith("SHO: no fees to collect");
            return;
        }

        expectedBaseFee = parseUnits(expectedBaseFee);
        expectedExtraFee = parseUnits(expectedExtraFee);

        const result = await contract.callStatic.collectFees();
        expect(result.baseFee).to.closeTo(expectedBaseFee, PRECISION_LOSS);
        expect(result.extraFee).to.closeTo(expectedExtraFee, PRECISION_LOSS);

        const collectorBalanceBefore = await shoToken.balanceOf(feeCollector.address);
        await contract.collectFees();
        const collectorBalanceAfter = await shoToken.balanceOf(feeCollector.address);
        expect(collectorBalanceAfter).to.equal(collectorBalanceBefore.add(result.baseFee).add(result.extraFee));
    }

    const claim = async(
        user, 
        nothingToClaim,
        amount, 
        expectedIncreasedFeePercentage, 
        expectedAvailableToClaim, 
        expectedReceivedTokens, 
        expectedUnlockedTokens
    ) => {
        contract = contract.connect(user);

        if (nothingToClaim) {
            await expect(contract.claim(0)).to.be.revertedWith("SHO: no tokens to claim");
            return;
        }

        amount = parseUnits(amount);
        expectedAvailableToClaim = parseUnits(expectedAvailableToClaim);
        expectedReceivedTokens = parseUnits(expectedReceivedTokens);
        expectedUnlockedTokens = parseUnits(expectedUnlockedTokens);
        expectedIncreasedFeePercentage = parseUnits(expectedIncreasedFeePercentage, 6);

        const result = await contract.callStatic.claim(amount);
        expect(result.increasedFeePercentage).to.closeTo(expectedIncreasedFeePercentage, "1000");
        expect(result.availableToClaim).to.closeTo(expectedAvailableToClaim, PRECISION_LOSS);
        expect(result.receivedTokens).to.closeTo(expectedReceivedTokens, PRECISION_LOSS);
        expect(result.unlockedTokens).to.closeTo(expectedUnlockedTokens, PRECISION_LOSS);

        const userBalanceBefore = await shoToken.balanceOf(user.address);
        const userInfoBefore = await contract.users(user.address);
        await contract.claim(amount);
        const userBalanceAfter = await shoToken.balanceOf(user.address);
        const userInfoAfter = await contract.users(user.address);
        expect(userBalanceAfter).to.equal(userBalanceBefore.add(result.receivedTokens));

        expect(userInfoBefore.allocation).to.equal(userInfoAfter.allocation);
        expect(userInfoAfter.feePercentageNextUnlock).to.equal(userInfoBefore.feePercentageNextUnlock + result.increasedFeePercentage);
        expect(userInfoAfter.totalUnlocked).to.equal(userInfoBefore.totalUnlocked.add(result.unlockedTokens));
        expect(userInfoAfter.totalClaimed).to.equal(userInfoBefore.totalClaimed.add(result.receivedTokens));
    }

    const eliminate = async(
        user, 
        eliminatedAlready,
        expectedUnlockedTokens
    ) => {
        contract = contract.connect(owner);

        if (eliminatedAlready) {
            await expect(contract.eliminateOption1User(user.address)).to.be.revertedWith("SHO: user already eliminated");
            return;
        }

        expectedUnlockedTokens = parseUnits(expectedUnlockedTokens);

        const unlockedTokens = await contract.callStatic.eliminateOption1User(user.address);
        await expect(unlockedTokens).to.closeTo(expectedUnlockedTokens, PRECISION_LOSS);

        const contractBalanceBefore = await shoToken.balanceOf(contract.address);
        const userInfoBefore = await contract.users(user.address);
        await contract.eliminateOption1User(user.address);
        const contractBalanceAfter = await shoToken.balanceOf(contract.address);
        const userInfoAfter = await contract.users(user.address);
        expect(contractBalanceAfter).to.equal(contractBalanceBefore);

        expect(userInfoBefore.allocation).to.equal(userInfoAfter.allocation);
        expect(userInfoAfter.feePercentageCurrentUnlock).to.equal(userInfoBefore.feePercentageCurrentUnlock);
        expect(userInfoAfter.feePercentageNextUnlock).to.equal(1e6);
        expect(userInfoAfter.totalUnlocked).to.equal(userInfoBefore.totalUnlocked.add(unlockedTokens));
        expect(userInfoAfter.totalClaimed).to.equal(userInfoBefore.totalClaimed);
    }

    before(async () => {
        [owner, feeCollector, user1, user2, user3] = await ethers.getSigners();
    });

    describe("Full flow test (option 0 users)", async() => {
        before(async() => {
            await init(
                [500000, 300000, 200000],
                [100, 2592000, 2592000],
                300000,
                {
                    wallets: [user1.address, user2.address, user3.address],
                    allocations: [1000, 2000, 3000],
                    options: [0, 0, 0]
                }
            );
        });

        it("check reverts when there are no passed unlocks yet", async() => {
            contract = contract.connect(feeCollector);
            await expect(contract.collectFees()).to.be.revertedWith("SHO: no fees to collect");

            contract = contract.connect(user1);
            await expect(contract.claim(0)).to.be.revertedWith("SHO: no unlocks passed");

            await time.increase(100);
        });

        it("check reverts", async() => {
            contract = contract.connect(feeCollector);
            await expect(contract.claim(0)).to.be.revertedWith("SHO: caller is not whitelisted");
    
            contract = contract.connect(user1);
            await expect(contract.claim(ethers.utils.parseUnits("1", 36))).to.be.revertedWith("SHO: amount to claim higher than allocation");

            await expect(contract.collectFees()).to.be.revertedWith("SHO: caller is not the fee collector");
        });

        it("first unlock - user 1 claims", async() => {
            await claim(user1, false, 0, 0, 350, 0, 350);
            await claim(user1, false, 0, 0, 350, 0, 0);
            await claim(user1, false, 350, 0.7, 350, 350, 0);
            await claim(user1, true);
        });

        it("first unlock - fees are collected", async() => {
            await collectFees(false, 900, 0);
            await collectFees(true);
        });

        it("first unlock - user 2 claims", async() => {
            await claim(user2, false, 0, 0, 700, 0, 700);
            await claim(user2, false, 0, 0, 700, 0, 0);
            await claim(user2, false, 350, 0.2, 700, 350, 0);
        });

        it("second unlock - user 1 has nothing to claim", async() => {
            await time.increase(2592000);
            await claim(user1, true);
        });

        it("second unlock - user 2 claims", async() => {
            await claim(user2, false, 0, 0, 650, 0, 300);
            await claim(user2, false, 150, 0, 650, 150, 0);
        });

        it("second unlock - user 3 claims", async() => {
            await claim(user3, false, 504, 0, 1680, 504, 1680);
        });

        it("second unlock - fees are collected", async() => {
            await collectFees(false, 540, 330);
            await collectFees(true);
        });

        it("last unlock - user 1 has nothing to claim", async() => {
            await time.increase(2592000);
            await claim(user1, true);
        });

        it("last unlock - fees are collected", async() => {
            await collectFees(false, 360, 220);
            await collectFees(true);
        });

        it("last unlock - user 2 claims", async() => {
            await claim(user2, false, 350, 0, 700, 350, 200);
            await claim(user2, false, 350, 0, 350, 350, 0);
            await claim(user2, true);
        });

        it("last unlock - user 3 claims", async() => {
            await claim(user3, false, 1596, 0, 1596, 1596, 420);
            await claim(user3, true);

            const contractBalance = await shoToken.balanceOf(contract.address);
            expect(contractBalance).to.equal(0);
        });
    });

    describe("Full flow test 2 (option 0 users)", async() => {
        before(async() => {
            await init(
                [333333, 333333, 333334],
                [0, 1296000, 2592000],
                300000,
                {
                    wallets: [user1.address, user2.address],
                    allocations: [333, 666],
                    options: [0, 0]
                }
            );
        });

        it("first unlock - user 1 claims", async() => {
            await claim(user1, false, 0, 0, 77.7, 0, 77.7);
            await claim(user1, false, 23.3, 0, 77.7, 23.3, 0);
        });

        it("first unlock - user 2 claims", async() => {
            await claim(user2, false, 0, 0, 155.4, 0, 155.4);
            await claim(user2, false, 77.69, 0.2, 155.4, 77.69, 0);
        });

        it("second unlock - user 1 claims", async() => {
            await time.increase(1296000);
            await claim(user1, false, 85.48, 0.4, 132.1, 85.48, 77.7);
        });

        it("last unlock - fees are collected", async() => {
            await time.increase(2592000);
            await collectFees(false, 299.7, 133.17);
            await collectFees(true);
        });

        it("last unlock - user 1 claims", async() => {
            await claim(user1, false, 333, 0, 79.92, 79.919, 33.3);
        });

        it("last unlock - user 2 claims", async() => {
            await time.increase(2592000);
            await claim(user2, false, 150, 0, 299.74, 150, 222.03);
            await claim(user2, false, 666, 0, 149.73, 149.73, 0);
            
            const contractBalance = await shoToken.balanceOf(contract.address);
            expect(contractBalance).to.equal(0);
        });
    });

    describe("Full flow test 3 (with option 1 users)", async() => {
        before(async() => {
            await init(
                [200000, 300000, 500000],
                [100, 2592000, 1296000],
                300000,
                {
                    wallets: [user1.address, user2.address, user3.address],
                    allocations: [1000, 2000, 3000],
                    options: [1, 1, 0]
                }
            );
        });

        it("check reverts", async() => {
            contract = contract.connect(owner);
            await expect(contract.eliminateOption1User(user1.address)).to.be.revertedWith("SHO: no unlocks passed");

            await time.increase(100);

            contract = contract.connect(user1);
            await expect(contract.eliminateOption1User(user2.address)).to.be.revertedWith("Ownable: caller is not the owner");

            contract = contract.connect(owner);
            await expect(contract.eliminateOption1User(user3.address)).to.be.revertedWith("SHO: not option 1 user");
            await expect(contract.eliminateOption1User(feeCollector.address)).to.be.revertedWith("SHO: not option 1 user");
        });

        it("first unlock - user 1 claims", async() => {
            await claim(user1, false, 0, 0, 140, 0, 140);
            await claim(user1, false, 140, 0, 140, 140, 0);
            await claim(user1, true);
        });

        it("first unlock - user 1 is eliminated", async() => {
            await eliminate(user1, false, 0);
            await eliminate(user1, true);
        });

        it("second unlock - fees are collected", async() => {
            await time.increase(2592000);
            await collectFees(false, 900, 210);
            await collectFees(true);
        });

        it("second unlock - user 1 tries to claim", async() => {
            await eliminate(user1, true);
            await claim(user1, true)
        });

        it("second unlock - user 2 is eliminated", async() => {
            await eliminate(user2, false, 700);
            await eliminate(user2, true);
            await collectFees(true);
        });

        it("second unlock - user 2 claims", async() => {
            await claim(user2, false, 350, 0, 700, 350, 0);
            await claim(user2, false, 350, 0, 350, 350, 0);
            await claim(user2, true);
        });
        
        it("last unlock - users try to claim", async() => {
            await time.increase(2592000);
            await claim(user1, true);
            await claim(user2, true);
        });

        it("last unlock - option 0 user claims", async() => {
            await claim(user3, false, 2100, 0, 2100, 2100, 2100);
            await claim(user3, true);
        });

        it("last unlock - fees are collected", async() => {
            await collectFees(false, 900, 1050);

            const contractBalance = await shoToken.balanceOf(contract.address);
            expect(contractBalance).to.equal(0);
        });
    });
});