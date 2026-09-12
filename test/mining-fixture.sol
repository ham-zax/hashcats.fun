// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Local integration fixture only. This is not the Hashcats implementation.
contract MiningFixture {
    uint256 public prevWork = 123;
    uint256 public mintPrice = 0.001 ether;
    uint256 public totalMinted;
    uint256 public currentEpoch;
    uint256 public constant ANCHOR_WINDOW = 250;
    uint256 public target = type(uint256).max / 8;
    mapping(uint256 => address) public ownerOf;
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function workHash(address miner, uint256 nonce, uint256 prev, bytes32 anchor) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(miner, nonce, prev, anchor)));
    }
    function targetFor(address) public view returns (uint256) { return target; }
    function currentAnchor() external view returns (uint256,bytes32) { return (block.number-1,blockhash(block.number-1)); }
    function changeWork() external { prevWork++; }
    function setTarget(uint256 value) external { target = value; }
    function mine(uint256 nonce,uint256 anchorBlock) external payable returns (uint256 tokenId) {
        require(msg.value == mintPrice, "price");
        require(anchorBlock < block.number && block.number-anchorBlock < ANCHOR_WINDOW, "anchor");
        uint256 work=workHash(msg.sender,nonce,prevWork,blockhash(anchorBlock));
        require(work < target, "proof");
        prevWork=work;
        tokenId=++totalMinted;
        ownerOf[tokenId]=msg.sender;
        emit Transfer(address(0),msg.sender,tokenId);
    }
}
