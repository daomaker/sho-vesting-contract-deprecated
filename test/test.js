const { expect } = require("chai");
const { time } = require("@openzeppelin/test-helpers");

describe("SHO smart contract", function() {
    let owner, feeCollector, user1, user2, user3, contract, shoToken, shoTokenDecimals;

    const PRECISION_LOSS = "1000000000000000";
    
    const parseUnits = (value, decimals = shoTokenDecimals) => {
        return ethers.utils.parseUnits(value.toString(), decimals);
    }

    const whitelistUsers = async(whitelist) => {
        const allocations = whitelist.allocations.map((raw) => parseUnits(raw));

        await expect(contract.whitelistUsers([owner.address], [1, 1])).to.be.revertedWith("PublicSHO: different array lengths");
        await expect(contract.whitelistUsers([], [])).to.be.revertedWith("PublicSHO: zero length array");

        contract = contract.connect(user1); 
        await expect(contract.whitelistUsers(whitelist.wallets, allocations))
            .to.be.revertedWith("Ownable: caller is not the owner");

        contract = contract.connect(owner); 
        await contract.whitelistUsers(whitelist.wallets, allocations);
        await expect(contract.whitelistUsers(whitelist.wallets, allocations))
            .to.be.revertedWith("PublicSHO: some users are already whitelisted");

        for (let i = 0; i < whitelist.wallets.length; i++) {
            const userInfo = await contract.users(whitelist.wallets[i]);
            expect(userInfo.allocation).to.equal(allocations[i]);
        }
        
        const globalTotalAllocation = whitelist.allocations.reduce((p, c) => p + c);
        await shoToken.transfer(contract.address, parseUnits(globalTotalAllocation));
        await expect(contract.whitelistUsers([owner.address], [1]))
            .to.be.revertedWith("PublicSHO: whitelisting too late");

        expect(await contract.globalTotalAllocation()).to.equal(parseUnits(globalTotalAllocation));
    }

    const testConstructorRequireStatements = async(unlockPercentages, unlockPeriods, initialFee, startTime) => {
        const Contract = await ethers.getContractFactory("PublicSHO");

        await expect(Contract.deploy(ethers.constants.AddressZero, unlockPercentages, unlockPeriods, initialFee, feeCollector.address, startTime))
            .to.be.revertedWith("PublicSHO: sho token zero address");

        await expect(Contract.deploy(shoToken.address, [], unlockPeriods, initialFee, feeCollector.address, startTime))
            .to.be.revertedWith("PublicSHO: 0 unlock percentages");

        const unlockPercentagesMany = new Array(201).fill(0);
        await expect(Contract.deploy(shoToken.address, unlockPercentagesMany, unlockPeriods, initialFee, feeCollector.address, startTime))
            .to.be.revertedWith("PublicSHO: too many unlock percentages");  

        await expect(Contract.deploy(shoToken.address, unlockPercentages, unlockPeriods.concat(1000), initialFee, feeCollector.address, startTime))
            .to.be.revertedWith("PublicSHO: different array lengths"); 
            
        await expect(Contract.deploy(shoToken.address, unlockPercentages, unlockPeriods, 1e6 + 1, feeCollector.address, startTime))
            .to.be.revertedWith("PublicSHO: initial fee percentage higher than 100%"); 
        
        await expect(Contract.deploy(shoToken.address, unlockPercentages, unlockPeriods, initialFee, ethers.constants.AddressZero, startTime))
            .to.be.revertedWith("PublicSHO: fee collector zero address"); 

        await expect(Contract.deploy(shoToken.address, unlockPercentages, unlockPeriods, initialFee, feeCollector.address, 10000000))
            .to.be.revertedWith("PublicSHO: start time must be in future"); 
    }

    const init = async(unlockPercentages, unlockPeriods, initialFee, whitelist, shoTokenDecimals = 18) => {
        const startTime = Number(await time.latest()) + 300;
        const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
        shoToken = await ERC20Mock.deploy("MOCK1", "MOCK1", owner.address, parseUnits(100000000), shoTokenDecimals);

        await testConstructorRequireStatements(unlockPercentages, unlockPeriods, initialFee, startTime);

        const Contract = await ethers.getContractFactory("PublicSHO");
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

        await expect(contract.sync()).to.be.revertedWith("PublicSHO: before startTime");

        contract = contract.connect(feeCollector);
        await expect(contract.collectFees()).to.be.revertedWith("PublicSHO: before startTime");

        contract = contract.connect(user1);
        await expect(contract.claim(0)).to.be.revertedWith("PublicSHO: before startTime");

        await time.increaseTo(startTime);
    }

    const collectFees = async(collectedAll, expectedBaseFee, expectedExtraFee) => {
        contract = contract.connect(feeCollector);
        if (collectedAll) {
            await expect(contract.collectFees()).to.be.revertedWith("PublicSHO: no fees to collect");
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
            await expect(contract.claim(0)).to.be.revertedWith("PublicSHO: no tokens to claim");
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

    before(async () => {
        [owner, feeCollector, user1, user2, user3] = await ethers.getSigners();
    });

    describe("Full flow test", async() => {
        before(async() => {
            await init(
                [500000, 300000, 200000],
                [0, 2592000, 2592000],
                300000,
                {
                    wallets: [user1.address, user2.address, user3.address],
                    allocations: [1000, 2000, 3000]
                }
            );
        });

        it("check claiming and collecting reverts", async() => {
            contract = contract.connect(feeCollector);
            await expect(contract.claim(0)).to.be.revertedWith("PublicSHO: caller is not whitelisted");
    
            contract = contract.connect(user1);
            await expect(contract.claim(ethers.utils.parseUnits("1", 36))).to.be.revertedWith("PublicSHO: passed amount too high");

            await expect(contract.collectFees()).to.be.revertedWith("PublicSHO: caller is not the fee collector");
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
    });
});